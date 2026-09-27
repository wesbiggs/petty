// Convert the headless xterm's visible buffer into C64 screen codes + colours.

import { COLS, ROWS, CELLS } from './protocol.js';
import { toScreenCode, INVERSE, SPACE } from './glyphs.js';
import { fgColor, bgColor, DEFAULT_FG, BOLD_FG, DIM_FG, SCREEN_BG } from './colors.js';

function cellFg(cell) {
  if (cell.isFgDefault()) return cell.isBold() ? BOLD_FG : cell.isDim() ? DIM_FG : DEFAULT_FG;
  return fgColor(cell.isFgRGB() ? 'rgb' : 'palette', cell.getFgColor());
}

function cellBg(cell) {
  if (cell.isBgDefault()) return null;
  return bgColor(cell.isBgRGB() ? 'rgb' : 'palette', cell.getBgColor());
}

export function cursorVisible(term) {
  // Not in xterm's public API; DECTCEM state lives on the core service.
  return !term._core?.coreService?.isCursorHidden;
}

// `panX` is the first terminal column shown, for terminals wider than the C64.
export function snapshot(term, panX = 0) {
  const glyph = new Int16Array(CELLS);
  const color = new Int16Array(CELLS);
  const buf = term.buffer.active;
  const cell = buf.getNullCell();
  const showCursor = cursorVisible(term);
  const cursorRow = buf.baseY + buf.cursorY - buf.viewportY; // off-screen when scrolled back

  for (let y = 0; y < ROWS; y++) {
    const line = buf.getLine(buf.viewportY + y);
    for (let x = 0; x < COLS; x++) {
      const i = y * COLS + x;
      if (!line || !line.getCell(panX + x, cell)) { glyph[i] = SPACE; color[i] = DEFAULT_FG; continue; }

      let g = cell.getWidth() === 0 || cell.isInvisible() ? SPACE : toScreenCode(cell.getChars());
      let fg = cellFg(cell);
      let bg = cellBg(cell);
      if (cell.isInverse()) [fg, bg] = [bg ?? SCREEN_BG, fg];
      if (showCursor && panX + x === buf.cursorX && y === cursorRow) [fg, bg] = [bg ?? SCREEN_BG, fg];

      // No per-cell background in text mode: a coloured background becomes an
      // inverted glyph drawn in the background colour (text shows as black).
      if (bg !== null && bg !== SCREEN_BG) {
        g ^= INVERSE;
        fg = bg;
      }
      glyph[i] = g;
      color[i] = fg;
    }
  }
  return { glyph, color };
}
