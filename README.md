# PETTY

A Commodore 64 terminal (PETSCII + TTY) for Claude Code or any other terminal
program.

The Mac runs the program in a 40×25 pty and emulates the terminal headlessly
(`@xterm/headless`). It sends the C64 only the screen cells that changed, already
converted to C64 screen codes and colours. The C64 client (1.2 KB of 6502) just
copies them into screen RAM and sends key presses back.

Unlike C64 chat clients for Claude (such as
[claude64](https://github.com/theletterf/claude64)), it runs the real Claude Code
CLI. And unlike on-C64 VT100 terminals (CBterm, GTERM), no escape sequences are
parsed on the C64, so it shows anything xterm can.

```
claude ⇄ pty ⇄ xterm (headless) → diff/encode ══ TCP / serial ══► C64: poke screen RAM
                    ▲                                               │
                    └──────────── keymap ◄═══ raw key matrix codes ═┘
```

## Requirements

- cc65 (`ca65`, `ld65`), VICE 3.x (`x64sc`), Node 20+
- On real hardware: a SwiftLink-compatible cartridge (6551 ACIA at `$DE00`, NMI)

## Run it in VICE

```bash
make                  # builds build/petty.prg (regenerates c64/glyphs.inc)
make bridge           # terminal 1: listens on 127.0.0.1:6464, spawns `claude` on connect
make vice             # terminal 2: VICE with an emulated SwiftLink on TCP 6464
```

Start the bridge first, because VICE connects when the client enables the ACIA.
To run something other than Claude: `make bridge CMD="-- bash --norc"`, or
`node bridge/src/bridge.js [--port N] [--fps N] [-v] -- <cmd> [args...]`.

If the program exits, press RETURN on the C64 to start it again. The session
survives C64 resets and reconnects; a reset just triggers a full redraw.

## Keys

| C64 | Sends | Claude Code meaning |
|---|---|---|
| RUN/STOP or ← | Esc | interrupt, Esc Esc = rewind |
| SHIFT+RUN/STOP | Ctrl+C | clear input / quit |
| RETURN / SHIFT+RETURN | Enter / Meta+Enter | submit / newline |
| F1 / F3 | Shift+Tab / Tab | cycle mode / complete |
| F5 / F7 | Ctrl+R / Ctrl+O | history search / transcript |
| F2 / F4 | PgUp / PgDn | |
| CRSR keys (+SHIFT) | arrows | |
| C=+CRSR↕ (+SHIFT) | scroll down (up), like a trackpad swipe: mouse wheel if the program tracks the mouse, else the bridge's 200-line scrollback | scroll |
| INST/DEL, SHIFT+INST | Backspace, Delete | |
| CLR/HOME, SHIFT+CLR | Home, Ctrl+L | redraw |
| CTRL+letter | control code | |
| C=+letter | Meta+letter | e.g. C=+P = model picker |
| £, SHIFT+£ | `\`, `\|` | |
| ↑, SHIFT+↑ | `^`, `~` | |
| SHIFT+: / SHIFT+; | `[` / `]` (C= gives `{` / `}`) | |
| SHIFT+@, SHIFT+- | `` ` ``, `_` | |

The mapping lives in [bridge/src/keymap.js](bridge/src/keymap.js).

## How it maps the display

- **Characters:** the lowercase character ROM is copied to RAM at `$3800`, and
  41 custom glyphs are patched over the PETSCII graphics: missing ASCII
  (`\ ^ _ \` { | } ~`), box drawing, `⏺ ❯ ✻ ✳ ✓ ✗ … ↑ ↓ → ▶`, and quadrant blocks
  for the logo. Codes 128–255 are the inverse of 0–127, so `█ ▐ ▄ ▛ ▜ ▙ ▟` cost
  nothing extra. Other Unicode is aliased or falls back to `?`. Edit
  [bridge/src/glyphs.js](bridge/src/glyphs.js); `make` regenerates `c64/glyphs.inc`.
- **Colours:** ANSI 16 colours use a hand-tuned table; 256-colour and truecolor use
  the nearest match in a Colodore-style palette.
- **Backgrounds:** text mode has no per-cell background. A cell with a coloured
  background is drawn as an inverse glyph in that colour, so diff lines show as
  solid green or red bars with dark text.
- **Cursor:** drawn by the bridge as an inverse cell when the program shows it.

## Protocol

See [bridge/src/protocol.js](bridge/src/protocol.js). Host→C64 opcodes are GOTO,
COLOR, PUT, REPEAT, SCROLL, COLORS, CLS and FRAME. Every frame ends with FRAME and
the C64 answers ACK. The bridge keeps only one frame in flight, so fast output
merges into fewer frames instead of overflowing the C64's 256-byte receive buffer.
C64→host messages are ACK, `KEY code mods` and HELLO.

For each frame the encoder tries every full-screen scroll offset and picks the
cheapest encoding. A spinner tick costs about 7 bytes, and a full redraw about
700–1500.

## Testing without a C64

```bash
cd bridge && npm test                                 # encoder vs reference decoder
node scripts/fake-c64.js 6464 $'echo hi\r'            # pretend C64: types keys, prints screen
```

## Layout

| Path | What |
|---|---|
| `c64/main.s` | ca65 client: NMI serial receive, command decoder, keyboard scan |
| `c64/petty.cfg` | linker config (program must end below `$3700`) |
| `bridge/src/bridge.js` | TCP server, pty, frame pacing |
| `bridge/src/screen.js` | xterm buffer → screen codes/colours |
| `bridge/src/protocol.js` | encoder and reference decoder |
| `bridge/src/glyphs.js` / `colors.js` / `keymap.js` | character, colour, key mappings |

Memory map: code `$0801–$0CB4`, receive ring `$3700`, character set `$3800–$3FFF`, screen `$0400`.

## Real hardware notes

- The SwiftLink's crystal doubles the 6551 rates, so the "19200" setting gives
  38400 baud. Connect a USB-serial adapter and have the bridge open the serial
  device instead of listening on TCP (not implemented yet).
- A SwiftLink-style WiFi modem can dial the bridge directly (`ATDT <mac-ip>:6464`), after the bridge is started with `--host 0.0.0.0`. The client would need a short dial step added first.
