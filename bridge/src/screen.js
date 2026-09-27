// Convert the headless xterm's visible buffer into screen codes + colours
// (C64 colour numbers, or VDC attributes on a C128).

import { DISPLAY } from './protocol.js';
import { toScreenCode, INVERSE, SPACE } from './glyphs.js';
import { palette } from './colors.js';
import { shareColours } from './soft80.js';
import { FONT4 } from './font4x8.js';

const KIND = { [DISPLAY.C64.id]: 'vic', [DISPLAY.C128.id]: 'rgbi', [DISPLAY.C64_80.id]: 'vic' };

// How much of each screen code's cell is foreground, 0-1, from the 4x8 font
// (close enough for the 8x8 one).
const COVER = Array.from({ length: 256 }, (_, code) => FONT4[code & 0x7f]
  .reduce((n, row) => n + [...((code & 0x80 ? ~row : row) & 15).toString(2)].filter(b => b === '1').length, 0) / 32);

// The palette a display shows in theme `theme` (see colors.js).
export const paletteFor = (display, theme = 'dark') => palette(KIND[display.id], theme);

function cellFg(cell, pal) {
  if (cell.isFgDefault()) return cell.isBold() ? pal.boldFg : cell.isDim() ? pal.dimFg : pal.defaultFg;
  return pal.fg(cell.isFgRGB() ? 'rgb' : 'palette', cell.getFgColor());
}

function cellBg(cell, pal) {
  if (cell.isBgDefault()) return null;
  return pal.bg(cell.isBgRGB() ? 'rgb' : 'palette', cell.getBgColor());
}

export function cursorVisible(term) {
  // Not in xterm's public API; DECTCEM state lives on the core service.
  return !term._core?.coreService?.isCursorHidden;
}

// Cells for a `display` ({cols, rows}); `panX` is the first terminal column
// shown, for terminals wider than the display. On a display with `pair`
// cells, the result also has `sprites` (see soft80.js).
export function snapshot(term, panX = 0, display = DISPLAY.C64, theme = 'dark') {
  const { cols, rows } = display;
  const pal = paletteFor(display, theme);
  const glyph = new Int16Array(cols * rows);
  const color = new Int16Array(cols * rows);
  const buf = term.buffer.active;
  const cell = buf.getNullCell();
  const showCursor = cursorVisible(term);
  const cursorRow = buf.baseY + buf.cursorY - buf.viewportY; // off-screen when scrolled back

  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(buf.viewportY + y);
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if (!line || !line.getCell(panX + x, cell)) { glyph[i] = SPACE; color[i] = pal.defaultFg; continue; }

      let g = cell.getWidth() === 0 || cell.isInvisible() ? SPACE : toScreenCode(cell.getChars());
      let fg = cellFg(cell, pal);
      let bg = cellBg(cell, pal);
      if (cell.isInverse()) [fg, bg] = [bg ?? pal.screenBg, fg];
      if (showCursor && panX + x === buf.cursorX && y === cursorRow) [fg, bg] = [bg ?? pal.screenBg, fg];

      // No per-cell background in text mode: a cell shows one colour and the
      // screen colour. Text on a coloured background becomes an inverted glyph
      // in the background colour (the text shows in the screen colour); a
      // glyph that covers most of its cell, like the blocks in Claude Code's
      // logo, keeps its own colour instead.
      if (bg !== null && bg !== pal.screenBg && COVER[g] < 0.5) {
        g ^= INVERSE;
        fg = bg;
      }
      glyph[i] = g;
      color[i] = cell.isUnderline() ? fg | pal.underline : fg;
    }
  }
  const screen = { cols, rows, glyph, color };
  if (display.pair) {
    const focus = cursorRow >= 0 && cursorRow < rows ? cursorRow : rows - 1;
    screen.sprites = shareColours(screen, focus);
  }
  return screen;
}
