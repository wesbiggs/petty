// Colours for the C64's soft 80-column screen. A hi-res bitmap cell holds two
// characters and one colour, so when two visible characters of different
// colours share a cell, one keeps the cell's colour and the other is redrawn
// on top in its own colour by a sprite.

import { FONT4 } from './font4x8.js';
import { SPACE } from './glyphs.js';

export const MAX_SPRITES = 8;
const SPRITE_COLS = 6; // a 24x21 sprite covers 6 characters of 4 pixels...
const SPRITE_ROWS = 2; // ...and 2 rows of 8 lines

// Rows of 4 pixels (bit 3 = left) for screen codes 0-255, 128-255 inverse.
const ROWS4 = Array.from({ length: 256 }, (_, code) =>
  FONT4[code & 0x7f].map(r => (code & 0x80 ? ~r : r) & 15));

// Which character keeps the cell's colour: letters and digits beat
// punctuation (a bracket in its neighbour's colour is hardly noticeable),
// otherwise more lit pixels win, so a coloured bar keeps its colour.
const WORD = new Set([...Array(26).keys()].flatMap(k => [k + 1, k + 65]).concat([...Array(10).keys()].map(k => k + 48)));
const WEIGHT = ROWS4.map((rows, code) =>
  rows.reduce((n, r) => n + (r & 1) + ((r >> 1) & 1) + ((r >> 2) & 1) + ((r >> 3) & 1), 0) +
  (WORD.has(code & 0x7f) ? 16 : 0));

// Make both characters of each cell the same colour, in place, and return up
// to MAX_SPRITES sprites ({col, row, color, data}) that repaint the characters
// that lost their colour: letters and digits first, then those nearest
// `focusRow` (the cursor). Each sprite takes as many losers of its colour as
// fit in it.
export function shareColours({ cols, glyph, color }, focusRow) {
  const losers = [];
  for (let i = 0; i < glyph.length; i += 2) {
    const [a, b] = [i, i + 1];
    const keep = WEIGHT[glyph[a]] >= WEIGHT[glyph[b]] ? a : b;
    const lose = keep === a ? b : a;
    if (glyph[lose] !== SPACE && color[lose] !== color[keep]) {
      losers.push({
        col: lose % cols, row: Math.floor(lose / cols), color: color[lose], glyph: glyph[lose],
        word: WORD.has(glyph[lose] & 0x7f),
      });
    }
    color[lose] = color[keep];
  }
  losers.sort((p, q) => q.word - p.word || Math.abs(p.row - focusRow) - Math.abs(q.row - focusRow) ||
    p.row - q.row || p.col - q.col);

  const inside = (m, col, row, color) => m.color === color &&
    m.col >= col && m.col < col + SPRITE_COLS && m.row >= row && m.row < row + SPRITE_ROWS;
  const sprites = [];
  while (losers.length && sprites.length < MAX_SPRITES) {
    // Of the placements that cover the first loser, the one covering most;
    // on a tie, the one starting at it.
    const first = losers[0];
    let s, most = 0;
    for (let row = first.row; row > first.row - SPRITE_ROWS; row--) {
      for (let col = first.col; col > first.col - SPRITE_COLS; col--) {
        if (row < 0 || col < 0) continue;
        const n = losers.filter(m => inside(m, col, row, first.color)).length;
        if (n > most) { most = n; s = { col, row, color: first.color, data: new Uint8Array(63) }; }
      }
    }
    for (let k = 0; k < losers.length;) {
      const m = losers[k];
      const dc = m.col - s.col, dr = m.row - s.row;
      if (!inside(m, s.col, s.row, s.color)) { k++; continue; }
      ROWS4[m.glyph].forEach((bits, y) => {
        for (let x = 0; x < 4; x++) {
          if (!((bits >> (3 - x)) & 1)) continue;
          const px = dc * 4 + x, line = dr * 8 + y;
          s.data[line * 3 + (px >> 3)] |= 0x80 >> (px & 7);
        }
      });
      losers.splice(k, 1);
    }
    sprites.push(s);
  }
  return sprites;
}
