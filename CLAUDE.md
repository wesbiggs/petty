# PETTY: notes for Claude

Bridge (Node, `bridge/`) plus 6502 clients (`c64/`, `c128/`). `make test` runs the bridge tests, `make` builds the clients,
`make game-check` checks the game hardware in VICE (opens a window).

## Known open items

From a code review. Not fixed on purpose or for lack of a way to test; pick them up when relevant.

- **Inline-image cells are shared by all sessions.** `cells` in `bridge/src/image.js` is module-level, so under `--max-sessions`
  sessions share one table of 65536 keys, reused round-robin. In practice one session's images outlast the others' traffic.
  A proper fix means per-session state threaded through `screen.js` (`snapshot`) and `protocol.js` (`encodeDiff` calls `imageCell`).
- **The program is spawned before HELLO.** With no start screen (`--title none`), or on a reconnect, `Session.attach` spawns the
  program at the default 40x25 and resizes it when HELLO says otherwise, so an 80-column client's program sees a SIGWINCH after
  it has started drawing. A fix: wait briefly for HELLO before the first spawn.
- **`bridge/src/serial.js` may leak or double-close its fd.** It wraps one fd in both a `tty.ReadStream` and a `tty.WriteStream`.
  Unverified: needs a real USB-serial adapter, and watching `lsof` across unplug/replug cycles.
- **Missing tests.** `bridge.js` has process-level tests only for connection guarding and `kick` (`test/session.test.js`).
  Not covered: `--idle-timeout`, reconnects, `--on-exit`, the lost-ACK resync, the sound-on-replaced-connection fix
  (needs the sound path), and `screen.js` (`snapshot`). `test/game-bridge.test.js` and others use fixed sleeps and may be
  flaky on a slow machine.
- **Private xterm APIs.** The bridge uses `term._core.coreMouseService`, `coreService.isCursorHidden` and `_inputHandler`
  (`bridge.js`, `screen.js`, `image.js`). `@xterm/headless` is `^6.0.0`: pin the exact version, or add a startup self-check that
  these exist, before taking a new xterm release.
- **`PETTY.CFG` (DIALASK) is untested on a real drive.** Tested in VICE with a D64 only. `cfg_load` loads straight into the cassette
  buffer, so a PETTY.CFG far longer than 71 bytes would overrun it (the end address is checked after the fact). Tested in VICE (x64sc, x128)
  on all four clients, never on hardware. The dial reads the modem through each client's RX ring (`dial_rx`), so a client's NMI
  must stay as it is.
- **RUN/STOP+RESTORE (`c64/restart.inc`) is untested with a real RESTORE key.** VICE cannot press it: the checks jumped to the
  KERNAL's NMI routine (C64) or the client's `nmi` (C128) with RUN/STOP faked in the keyboard variable. It takes an NMI the ACIA did
  not raise (status bit 7 clear) for RESTORE, so a RESTORE that arrives with a byte pending is missed. The modem hang-up (`+++`, `ATH`)
  was tried only against `fake-modem.js`.
- **Untested on hardware.** The lost-ACK resync (2400 no-op bytes) has only been tested against the reference decoder, not a
  client in VICE. The W65C51N transmit-empty caveat in the README is unverified.
