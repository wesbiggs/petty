# Game hardware: notes

What was added so that a game can run entirely on the host and use the C64 for its sprites, sound and screen, why it
is shaped as it is, and what is not done. The usage is in the [README](../README.md#game-hardware-the-c64-text-and-hi-res-clients).
It came from a read of [q4k](https://github.com/wesbiggs/q4k) (Quest for the King), whose player and shots are sprites and
whose music and effects are SID writes from an interrupt.

## Design

- **The C64 stays dumb; the bridge owns the state.** Like the screen, sprites and SID scripts are state the bridge keeps (`game.js`) and
  sends as changes. A client that restarts (HELLO), or a frame that was lost (ACK timeout), gets all of it again. A program can re-say where
  everything is every frame and nothing is sent for what did not change.
- **What the link cannot carry, the C64 does itself.** 38400 baud is 3.8 KB/s and display frames are 20 a second, so a sprite that moves 2
  pixels a frame cannot be driven from the host. `GLIDE` (per-frame deltas, ticked by a raster interrupt at line 251) and SID scripts
  (register writes with frame delays, read from RAM) are the two things that run on the C64 between messages.
- **One interpreter for music and effects.** A script is records of register writes and a delay in frames. A channel plays one script and
  has a mask of the 25 SID registers it may write; music on voices 1-2 (and the volume) and an effect on voice 3 cannot clobber one another,
  which is what q4k's interrupt player does by convention. `play` restarts a channel, gates down first, so a repeated effect is struck again.
- **Order on the wire.** Sound goes before the frame's screen changes (and a `play` is sent at once, as a frame of its own, if the link is free),
  sprites after them, so a tile and the sprite on it change together.
- **MOVE.** A scrolling map would cost about 2 KB a step as cells (0.5 s at 38400 baud). The bridge now searches each frame (only for a program that
  has used the game OSCs) for a block that moved by up to 3 cells either way, and sends `MOVE x y w h dx dy` plus the cells that are new.
  The client implementations are in `game.inc`: text (screen codes and colour RAM) and hi-res (8 bitmap bytes and a colour byte a cell).
- **The raster interrupt is chained in front of the KERNAL's** and is only switched on by the first `GLIDE` or `SIDPLAY`, so a session that never
  uses it behaves as before. While a sound plays (SOUND), interrupts are off and everything here waits; the bridge then clears the SID and
  starts looping scripts again.

## Using it from q4k

| q4k | PETTY |
|---|---|
| hero: tunic, figure, outline sprites 0-2, shapes in `$0340-$03FF`, `sprite_walk` glides 2 px x 4 frames | three sprites with `set`; eight frames of each as shape slots (24 of 64); a step is a `set` with the next frame's slot and `glide N 2 0 4` |
| `sprite_shot`: a sprite flies `squares * 2` frames at 4 px | `set` at the start, `glide N 4 0 frames`, `sync` (or wait `frames / 50` s), `hide` |
| `music.s`, interrupt, voices 1-2 | one script with the tune (`mkmusic.py` could write the OSC instead of `music_data.s`), `play 0 id 1+2+vol`; `M` is `stop 0` / `play` |
| `sfx_step`, `sfx_play`: voice 3, a table of steps (frames, waveform, pitch, pitch change per frame) | a script per effect on channel 1 with voice mask `3`; the pitch sweep is one record per frame; `sfx_delay` is a timer on the host |
| `music_pause()` around disk access | not needed: there is no disk |
| keyboard (`wait_key`, repeat) | the same keys arrive as bytes; no key-up |
| screen codes `$60+` for tiles, `$80-$91` for actors | private-use characters with `--charset` slots. The text client has 128 (0-127) in all, which the text of the game and PETTY's own glyphs take most of: **use the hi-res client**, whose slots 128-255 are free for tiles (and which has per-cell backgrounds) |
| 40x25 viewport scrolling by a cell | print the viewport again; the bridge turns it into MOVE |
| `modem.c`, `savegame.c`, `vault.s`, the generators in 6502 | host code; `host/geo.py`, `isleref.py` and `townref.py` already model the generators |

## Open issues and assumptions

- **Nothing here has run on real hardware**, nor on an NTSC machine: the checks are VICE (x64sc, PAL, new CIA), through `make game-check`
  (shapes, pointers, positions across x = 256, flags, glide frames and the done message, random MOVEs against the reference decoder, script
  timing and masking from VICE's SID dump), unit tests, and the bridge end to end with a fake client. A sprite was seen moving, and the
  music writing the SID, with a real bridge, the demo and VICE together; nobody has looked at the screen or listened.
- **Not tested: a sound playing while a game runs** (`say` / `play` with sprites on and a tune looping). The code path is there (the client turns the
  sprites off and restores them, as before; the bridge sends SIDRESET and restarts looping scripts afterwards) but the one VICE run done
  (`sound-capture.js` on the text client) only got as far as "sound done": VICE did not write its recording here, so no score.
- **MOVE on the hi-res client** takes about 50 ms for a 21x19 block (8 bytes a cell); the text client's is about a tenth of that. It fits the 4K ring
  but is not measured on the machine. Only the text and hi-res clients have the game commands: the soft 80-column and C128 clients ignore them,
  and the bridge sends them nothing (`display.game`).
- **`sync` can be early.** The C64 says "all glides ended", not which; if a glide is started in the few milliseconds around another's end, `sync` can
  return when the first ends. There is also a timeout (frames * 20 ms + 400 ms), so a lost message does not hang a program.
- **Scripts count frames**, not milliseconds, so tempo is 50 or 60 a second by machine, as q4k's is. A program that wants one tempo has to ask the
  bridge's region (not exposed) or accept it.
- **Memory.** Shapes: 64 slots, which is what fits below the receive ring (text) and the colours (hi-res). Scripts: `$9000-$BFFF` (12 KB, bump-allocated and
  not freed until the session ends; a redefinition that fits reuses its place). No check that a script's addresses do not collide with a sample player's tables
  (`$CD00-$CFFF`, above the range).
- **Sprite details not verified by eye:** multicolour and expanded sprites (registers checked, not rendered), the priority between sprites and
  `b` (behind text), colours on the hi-res bitmap.
- **No key-up and no joystick.** Keys arrive as presses with the PETTY auto-repeat (20 jiffies, then every 3). A game that wants held keys, the
  joystick ports or paddles would need new client messages.
- **The SID filter and the master volume are shared**: a script that writes the volume register (24) can change the other channel's loudness unless
  its voices mask leaves `vol` out. That is the author's choice (`1+2` against `1+2+vol`), as it is in q4k, where `sfx_play` sets the volume.
- **The client grew** (text: to about `$16DB`, hi-res: to about `$199B`; both are limited to `$2000` by their linker configs, because the text client's sprite shapes start there).
  The raster interrupt adds a few hundred cycles a frame once it is on; the interaction with the sound player's raster lock is not measured, because
  that runs with interrupts off.
- Fixed on the way: the bridge crashed on a hi-res or C128 client when run without `--charset` (`GlyphCache` was given `null`).
