# Changelog

## Unreleased

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
