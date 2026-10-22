// Colours for the C64's soft 80- and 53-column screens. A hi-res bitmap cell
// is 8 pixels wide and holds one colour. Characters 4 pixels wide (80
// columns) share a cell in pairs; characters 6 pixels wide (53 columns)
// straddle cells, so each run of 4 characters (24 pixels, 3 cells) shares one
// colour. When visible characters of different colours share a group, one
// colour keeps it and the other characters are redrawn on top in their own
// colour by sprites.

import { FONT4 } from './font4x8.js';
import { FONT6 } from './font6x8.js';
import { SPACE } from './glyphs.js';

export const MAX_SPRITES = 8;
const SPRITE_PIXELS = 24; // a 24x21 sprite covers 24 / width characters...
const SPRITE_ROWS = 2; // ...and 2 rows of 8 lines

// Rows of `width` pixels (high bit = left) for screen codes 0-255, 128-255 inverse.
const rowsOf = (font, width) => Array.from({ length: 256 }, (_, code) =>
  font[code & 0x7f].map(r => (code & 0x80 ? ~r : r) & ((1 << width) - 1)));
const ROWS = { 4: rowsOf(FONT4, 4), 6: rowsOf(FONT6, 6) };

// Which colour a group keeps: letters and digits beat punctuation (a bracket
// in its neighbour's colour is hardly noticeable), otherwise more lit pixels
// win, so a coloured bar keeps its colour.
const WORD = new Set([...Array(26).keys()].flatMap(k => [k + 1, k + 65]).concat([...Array(10).keys()].map(k => k + 48)));
const bits = r => r.toString(2).replace(/0/g, '').length;
const weights = rows => rows.map((glyph, code) =>
  glyph.reduce((n, r) => n + bits(r), 0) + (WORD.has(code & 0x7f) ? 16 : 0));
const WEIGHT = { 4: weights(ROWS[4]), 6: weights(ROWS[6]) };

// Characters `width` pixels wide that share colour cells, as runs of this many.
const groupOf = width => { let n = 1; while ((n * width) % 8) n++; return n; };

// Make the characters of each group the same colour, in place, and return up
// to MAX_SPRITES sprites ({col, row, color, data}) that repaint the characters
// that lost their colour: letters and digits first, then those nearest
// `focusRow` (the cursor). Each sprite takes as many losers of its colour as
// fit in it.
export function shareColours({ cols, glyph, color }, focusRow, width = 4) {
  const rowsOfCode = ROWS[width], weight = WEIGHT[width], group = groupOf(width);
  const losers = [];
  for (let row = 0; row * cols < glyph.length; row++) {
    for (let x = 0; x < cols; x += group) {
      const start = row * cols + x, end = row * cols + Math.min(x + group, cols);
      // The colour with the most weight among the group's visible characters;
      // on a tie, or with none visible, the first.
      const total = new Map();
      for (let i = start; i < end; i++) {
        if (glyph[i] !== SPACE) total.set(color[i], (total.get(color[i]) ?? 0) + weight[glyph[i]]);
      }
      let keep = color[start], most = -1;
      for (const [c, n] of total) if (n > most) [keep, most] = [c, n];
      for (let i = start; i < end; i++) {
        if (glyph[i] !== SPACE && color[i] !== keep) {
          losers.push({ col: i % cols, row, color: color[i], glyph: glyph[i], word: WORD.has(glyph[i] & 0x7f) });
        }
        color[i] = keep;
      }
    }
  }
  losers.sort((p, q) => q.word - p.word || Math.abs(p.row - focusRow) - Math.abs(q.row - focusRow) ||
    p.row - q.row || p.col - q.col);

  const spriteCols = SPRITE_PIXELS / width;
  const inside = (m, col, row, color) => m.color === color &&
    m.col >= col && m.col < col + spriteCols && m.row >= row && m.row < row + SPRITE_ROWS;
  const sprites = [];
  while (losers.length && sprites.length < MAX_SPRITES) {
    // Of the placements that cover the first loser, the one covering most;
    // on a tie, the one starting at it.
    const first = losers[0];
    let s, most = 0;
    for (let row = first.row; row > first.row - SPRITE_ROWS; row--) {
      for (let col = first.col; col > first.col - spriteCols; col--) {
        if (row < 0 || col < 0) continue;
        const n = losers.filter(m => inside(m, col, row, first.color)).length;
        if (n > most) { most = n; s = { col, row, color: first.color, data: new Uint8Array(63) }; }
      }
    }
    for (let k = 0; k < losers.length;) {
      const m = losers[k];
      const dc = m.col - s.col, dr = m.row - s.row;
      if (!inside(m, s.col, s.row, s.color)) { k++; continue; }
      rowsOfCode[m.glyph].forEach((r, y) => {
        for (let x = 0; x < width; x++) {
          if (!((r >> (width - 1 - x)) & 1)) continue;
          const px = dc * width + x, line = dr * 8 + y;
          s.data[line * 3 + (px >> 3)] |= 0x80 >> (px & 7);
        }
      });
      losers.splice(k, 1);
    }
    sprites.push(s);
  }
  return sprites;
}
