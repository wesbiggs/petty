# Changelog

## Unreleased

- **One C64 client with four screens** (`petty.prg`): the text, hi-res, soft 80-column and the new soft 53-column screens in
  one program, which replaces `petty.prg` (text), `pettyhires.prg` and `petty80.prg`. It starts on hi-res (`make START=c64-80`
  and so on for another), and says which displays it can show after its `HELLO_ON` (`MODES`); the bridge switches it with
  `MODE` (both new in the protocol), which clears the screen and redraws it all, resizing the program's terminal. The screen is
  chosen by the user (C=+F3 / C=+F4, the control port's `mode`, `--mode`), or by a program: OSC 8350 `mode ; SPEC` (a display,
  flags such as `game`, or a width) is answered once the client is on it; `petty-mode SPEC command` does it for any program.
  Every C64 screen keeps its memory in the VIC's second bank, with BASIC's ROM switched out.
- **Soft 53-column screen**: 53×25 in the hi-res bitmap with a 6×8 font (`bridge/src/font6x8.js`, generated into
  `c64/font6x8.inc`), display 4. Each group of four characters (three bitmap cells) shares a colour, and sprites repaint the
  characters that lost theirs, as on the soft 80-column screen (`soft80.js` now handles both). OSC 8350 reports it as `c64-53`
  with the flag `quad`. `mock-soft80.js --53`.
- **What one screen can do, the others can** where the machine allows (README: What each screen can do): sprites, glides,
  `MOVE` and SID scripts on the soft screens (the game's sprites take numbers from the colour repairs; `MOVE` moves whole
  groups of columns); full-screen pictures on every C64 screen; underline on the soft screens; `imgcat` pictures in pixels on
  the soft screens (whole bitmap cells, with the new `CELLS` command) and on the C128 (a character a cell, in one colour on the
  screen colour, loaded with `GLYPH`). OSC 8350 has the flags `picture` and `images`.
- **`petty-view FILE`** shows a picture full screen until a key is pressed, on any C64 screen: Koala in multicolour, Art Studio
  and Doodle! in hi-res (the new `VIEW` mode 3), and anything else converted (`-t hires` for hi-res).
- SID scripts have `$9000-$9FFF` (4 KB), not `$9000-$BFFF`: above `$A000` the old text and hi-res clients read BASIC's ROM.
- Fix: flat conversion (`-t flat`) of a picture with more than 32767 colours drew much of it black.
- **RUN/STOP+RESTORE restarts the client** (both): the screen, SID, sprites and interrupts are set up again, the client says
  HELLO anew (the bridge redraws everything) and, in a build that dials, hangs the modem up (`+++`, `ATH`) and dials again.
  RESTORE alone does nothing, as before. `c64/restart.inc`; `bridge/scripts/fake-modem.js` understands `+++` and `ATH`.
- **Dial setup on the C64** (`make DIALASK=1`, both clients): the modem's start-up command, the bridge's address and a
  dial-progress switch are asked for on the screen, kept in `PETTY.CFG` on the last device used, and asked again when the
  call does not come in about 10 seconds. `DIALINIT=ATC` sends a command line before `ATDT` (for a TeensyROM's Ethernet modem,
  which also waits longer for the answer to it), and `DIALDEBUG=1` shows the dial's progress on the screen. The clients' dial step now reads the modem through the receive ring their NMI fills, not by polling the ACIA.
- **OSC 8350 `display`**: a program asks which display it is drawing on and what it can do, and is answered once the client has said
  HELLO (`c64`, `c64-hires`, `c64-80`, `c64-53`, `c128`, with its size and flags). `bridge/scripts/ask-display.js`. See the README.
- Checks in VICE: `make screen-check` (each C64 screen against the reference decoder, and switching), `make game-check`,
  `make picture-check`; `bridge/scripts/vice.js` is their shared harness. `fake-c64.js` behaves as the C64 client (`--display`
  to start on another screen, `--c128`).

## 0.11.0

- Security: a TCP connection that does not open with HELLO is dropped, and so is a control-port connection whose first line is no
  command (an HTTP request from a web page could type into the program). README: Security.
- Fix: `kick` on a single-session bridge left it unable to take another client.
- Fix: a client that reconnected while a sound played left the session's sound queue stuck for good.
- Fix: inline PNGs are limited to 16 M pixels and inflate to their stated size (a 31 KB file could take 1 GB).
- Fix: in the `classic` theme a colour used as both foreground and background could come out as the screen colour.
- After a lost ACK the full redraw is preceded by no-op bytes, so a client that lost part of a command is back in step.
- The pty is paused while the terminal has output to parse. `MOVE` bounds each argument before adding them. C=+CRSR up/down
  on the alternate screen honours application cursor mode.

- A character with no glyph shows as a middot (·) instead of `?`. Emoji and other wide characters are now two cells in the bridge's terminal
  (it counted them as one, which shifted the rest of the line): the first cell is the middot and the second a space. `bridge/src/unicode.js`.
- Game hardware for the C64 text and hi-res clients, for a program that runs wholly on the host: hardware sprites (**OSC 8348**: shapes, positions,
  `glide` that the C64 animates by itself, `sync`) and the SID (**OSC 8349**: register-write scripts uploaded once and played from a
  raster interrupt on four masked channels, or written directly). New client commands SPRDEF, SPR, GLIDE, MOVE, SIDW, SIDPLAY,
  SIDSTOP, SIDRESET and SPRMC, and the message GLIDE. For a program that uses them the bridge also sends a rectangle that moved a few
  cells (a scrolling map) as MOVE. `bridge/lib/pettygame.py`, `bridge/examples/game-demo.py`, `make game-check`. See the README.
  The text client now ends below `$2000` (it reached about `$1690`), where the sprite shapes start.
- Fix: the bridge crashed on a hi-res or C128 client when run without `--charset`.

- `--max-sessions N`: a session of its own for every TCP connection, up to N (more are refused), ended with the connection.
  The bridge's terminal, pty, display, theme, images and sound are now per session. Also `--idle-timeout S`,
  `--on-exit close`, `PETTY_SESSION` in the program's environment, TCP keepalive, and `sessions`, `@N` and `kick` on the control port.
  Without `--max-sessions`, behaviour is as before: one session that survives reconnects.
- The control port now listens on `127.0.0.1` rather than `--host`; `--control-host` changes that.

- `--charset FILE`: redraw glyphs, or add characters, on the C64 text and hi-res clients. The text client takes them with POKE
  (and the inverse half) into spare screen codes (0-127); the hi-res client with GLYPH, in 0-127 or in the extended slots 128-255,
  which the glyph cache then leaves alone. A game can ship its own font or tiles with a stock `.prg`.

## 0.10.1

- Speech without macOS `say`: falls back to `espeak-ng` or `espeak`, and otherwise says to use `--tts`.
- `--sound-lut FILE`: a measured output table for the bridge, as well as `sid6581` and `sid8580`.
- `staircase.prg` (`make build/staircase.prg`, in the release): a standalone program that plays the SID volume staircase, and
  `bridge/scripts/sound-calibrate.js`, which measures a line-in recording of it into a table for `--sound-lut`.
- `docs/sound.md`: the measurements and dead ends behind the sound.

## 0.10.0

Sound: programs in the terminal can speak and play music through the SID.

- `say` and `play` commands (in `bridge/bin/sound`, first in the program's PATH) send OSC 8347 to the bridge, which
  prepares the audio (any TTS command with `--tts`, ffmpeg for files) and streams it to the C64 as 2-bit adaptive
  delta codes at about 7.8 kHz through the SID volume register. Also over ssh (`play -i` sends the file inline).
- Playback is modal: the screen stays on and still, program output waits in the bridge and is drawn after.
  RUN/STOP stops a sound and clears the queue.
- All four clients (text, soft 80-column, hi-res, C128) play sound. The C128 drops to 1 MHz with the ROMs out
  while it plays. Sprites are off during playback.
- The bridge asks the client for its video frame length (PAL or NTSC) and times the samples to match. New
  protocol commands SOUND and PROBE, new messages DONE, CREDIT, PROBE and ABORT; flow control by credit, as a SwiftLink has no handshake.
- New bridge options `--sound on|off`, `--tts`, `--voice`, `--sound-weight`, `--sound-lut`, `--sound-delay`, `--sound-out`;
  `say TEXT` and `play FILE` on the control port.
- The sample clock is CIA 2 timer B, which works on the old 6526 CIA as well as the new one.
- Fix: a stale ACK timer could fire later, logging a spurious timeout and forcing a redraw.

Not tested yet: RUN/STOP on the C64, a real SwiftLink or machine.

## 0.9.0

First tagged release: the text, soft 80-column, hi-res and C128 clients, pictures, themes, serial and WiFi modem bridging.
