# PETTY: notes for Claude

Bridge (Node, `bridge/`) plus 6502 clients (`c64/`, `c128/`). `make test` runs the bridge tests, `make` builds the clients,
`make screen-check` checks the C64 client's screens in VICE against the reference decoder, `make game-check` the game hardware and
`make picture-check` full-screen pictures, CELLS and underline, on each screen (they need `x64sc`; a headless VICE build works).

There are two clients: `petty.prg` (C64) and `petty128.prg`. The C64 client (`c64/main.s`) has four screens, `text.s`, `hires.s`,
`soft80.s` and `soft53.s`, each assembled in a `.scope` of its own; `main.s` has what they share once (ring, keyboard, dial, sound,
game hardware, VIEW, CELLS, POKE). A capability added to one screen should go to the others where the machine allows (README, "What
each screen can do"). Inside a scope, `.if` on a global constant needs `::` (`.if ::DIAL_DBGCODE`): ca65 doesn't look in the
enclosing scope there (`.ifdef` does). When a change should not touch the program, check it byte for byte against the last build.

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
  on the single-screen C64 clients this one replaced and on the C128, never on hardware; on today's C64 client (it asks on its text screen)
  only the setup screen was looked at. The dial reads the modem through each client's RX ring (`dial_rx`), so a client's NMI must stay as it is.
- **RUN/STOP+RESTORE (`c64/restart.inc`) is untested with a real RESTORE key.** VICE cannot press it: the checks jumped to the
  KERNAL's NMI routine (C64) or the client's `nmi` (C128) with RUN/STOP faked in the keyboard variable. It takes an NMI with no byte
  waiting and status bit 7 clear for RESTORE, so a RESTORE that arrives with a byte pending is missed. (A byte waiting is always
  taken: `send`'s status reads clear bit 7 too, and lost a byte now and then while the client was sending, e.g. keys repeated fast.) The modem hang-up (`+++`, `ATH`)
  was tried only against `fake-modem.js`.
- **The C64 client (`petty.prg`, four screens) is tested in VICE only.** Each screen matches the reference decoder after random frames
  (`make screen-check`), the game and picture checks pass on every screen, and the dial, `DIALASK`'s setup screen and RUN/STOP+RESTORE
  (faked as above) were tried once by hand, before the game hardware, pictures and images came to the soft screens. Sound was measured
  on its hi-res screen only. C=+F3 was not pressed in VICE: the key is covered by the bridge's tests. `PETTY.CFG` does not hold the
  screen to start on (only `make START=...` does).
- **A connection that never says HELLO still takes the session over first.** `Session.attach` drops the current client as soon as a
  TCP connection arrives, before `onData` sees whether it opens with HELLO, so anything connecting to the client port (a port scan, a
  mistyped `petty-ctl --port`) hangs up the real C64. Seen while testing; not fixed.
- **Game hardware, pictures, inline images and underline on the soft screens, and images on the C128, are tested in VICE only**
  (x64sc, x128, headless), never on hardware. On the soft screens a sprite that repaints a colour draws the character but not its
  underline, and text written over part of an image's cell takes that cell's colour. C128 images were looked at in an x128 screenshot,
  whose VDC pixels are square, not as on a monitor.
- **SID scripts now have 4 KB, `$9000-$9FFF`** (`game.js` SCRIPT_END), where they had `$9000-$BFFF`: past `$A000` the old text and
  hi-res clients read BASIC's ROM, and that RAM now holds the soft screens' glyph tables. A program that defines more gets "script memory is full".
- **Images converted for one display show on another as best they can.** An image is converted when it arrives, for the display then:
  after a switch (or if it arrived before the client's HELLO), a soft screen shows a hi-res image as blocks, and so on.
- **Untested on hardware.** The lost-ACK resync (2400 no-op bytes) has only been tested against the reference decoder, not a
  client in VICE. The W65C51N transmit-empty caveat in the README is unverified.
