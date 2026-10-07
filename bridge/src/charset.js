// --charset FILE: redefines glyphs on the C64 text and hi-res clients.
//
// The file is JSON, characters to glyphs. A glyph is 8 rows, each a string of
// 8 pixels ('#' set, '.' clear) or a number 0-255:
//
//   { "#": ["########", "#...#...", ...],               redraws the glyph '#' has
//     "": { "slot": 112, "rows": [...] } }         a new character, in screen code 112
//
// Text client: it has no spare screen codes. 0-127 are the ROM's lowercase set
// plus the glyphs in glyphs.js, so a new character takes over one of them
// (112 is ✻, 109 is ⏺, 97-108 are box corners and tees). The client makes
// 128-255 the inverse of 0-127 when it starts, so the inverse of each glyph is
// sent too, with POKE. A "slot" of 128 or more is not for this client.
//
// Hi-res client: the same slots 0-127, loaded with GLYPH (it needs no inverse
// half), and slots 128-255, which are the extended glyphs' (glyphcache.js):
// a slot given here is kept out of that cache, which has that many fewer to share.
// A character drawn from the extended glyphs (●, ═, braille ...) is redrawn by
// changing that glyph.
//
// The other clients (soft 80, C128) draw their own fonts, and show a new character as '?'.

import { readFileSync } from 'node:fs';
import { toScreenCode, INVERSE } from './glyphs.js';
import { extendedGlyph } from './extglyphs.js';
import { OP, encodePoke } from './protocol.js';

export const CHARSET_ADDR = 0x3800; // c64/main.s CHARSET: 2K, 8 bytes a screen code
const INVERSE_ADDR = CHARSET_ADDR + 0x400;

// snapshot() glyph numbers 0x8000 + slot are the hi-res client's slots 128-255, which
// are not inverse screen codes (and not extended glyphs: those start at EXT).
export const FIXED = 0x8000;

function rowByte(row, where) {
  if (typeof row === 'number' && Number.isInteger(row) && row >= 0 && row <= 255) return row;
  if (typeof row === 'string' && /^[#.]{8}$/.test(row)) return parseInt(row.replaceAll('#', '1').replaceAll('.', '0'), 2);
  throw new Error(`${where}: a row is 8 pixels of # and ., or a number 0-255`);
}

// The parsed JSON ->
//   glyphs: Map(slot 0-255 -> 8 bytes)
//   chars:  Map(new character -> slot)
//   redraws: Map(character -> 8 bytes), for those that have a glyph already
export function parseCharset(json) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) throw new Error('want an object of characters to glyphs');
  const chars = new Map(), glyphs = new Map(), redraws = new Map();
  for (const [ch, def] of Object.entries(json)) {
    const where = `'${ch}'`;
    if ([...ch].length !== 1) throw new Error(`${where}: a key is one character`);
    const { slot, rows } = Array.isArray(def) ? { slot: undefined, rows: def } : def ?? {};
    if (!Array.isArray(rows) || rows.length !== 8) throw new Error(`${where}: a glyph is 8 rows`);
    let code = slot;
    if (code === undefined) {
      code = toScreenCode(ch);
      if (code & INVERSE) throw new Error(`${where}: is drawn as an inverse glyph, so give a "slot"`);
      if (code === toScreenCode('?') && ch !== '?' && extendedGlyph(ch) === undefined) {
        throw new Error(`${where}: has no glyph to redraw (it shows as '?'), so give a "slot"`);
      }
    } else if (!Number.isInteger(code) || code < 0 || code > 255) {
      throw new Error(`${where}: "slot" is a screen code 0-255`);
    }
    const bytes = Uint8Array.from(rows, r => rowByte(r, where));
    const old = glyphs.get(code);
    if (old && old.some((b, i) => b !== bytes[i])) throw new Error(`${where}: screen code ${code} is already given another glyph`);
    glyphs.set(code, bytes);
    if (slot === undefined) redraws.set(ch, bytes); else chars.set(ch, code);
  }
  return { chars, glyphs, redraws };
}

export function loadCharset(file) {
  try {
    return parseCharset(JSON.parse(readFileSync(file, 'utf8')));
  } catch (e) {
    throw new Error(`--charset ${file}: ${e.message}`);
  }
}

// What a display can load: slots 0-127 on the text client; 0-255 on the hi-res one.
const slotsOf = display => display.hires ? 256 : display.ext || display.pair ? 0 : 128;
const usable = (cs, display) => [...cs.glyphs].filter(([code]) => code < slotsOf(display));

// New characters -> the snapshot glyph number that shows them, for glyphs.js's overrides.
export function charsFor(cs, display) {
  const out = new Map();
  for (const [ch, slot] of cs.chars) if (slot < slotsOf(display)) out.set(ch, slot < 128 ? slot : FIXED + slot);
  return out;
}

// Hi-res slots 128-255 that the extended-glyph cache must leave alone.
export const reservedSlots = (cs, display) => display.hires ? [...cs.glyphs.keys()].filter(s => s >= 128) : [];

// Redrawn extended glyphs (hi-res only): glyph number (EXT + index) -> 8 bytes.
export function extRedraws(cs, display) {
  const out = new Map();
  if (display.hires) for (const [ch, bytes] of cs.redraws) { const g = extendedGlyph(ch); if (g !== undefined) out.set(g, bytes); }
  return out;
}

// The commands that load the glyphs into a client after a reset (none, if the display is neither).
export function charsetCommands(cs, display) {
  if (display.hires) return usable(cs, display).flatMap(([code, bytes]) => [OP.GLYPH, code & 0xFF, code >> 8, ...bytes]);
  if (slotsOf(display) === 0) return [];
  // The text client: POKE, neighbouring screen codes in one command, and the inverse half.
  const glyphs = new Map(usable(cs, display));
  const out = [];
  for (const base of [CHARSET_ADDR, INVERSE_ADDR]) {
    const codes = [...glyphs.keys()].sort((a, b) => a - b);
    for (let i = 0; i < codes.length;) {
      let j = i;
      while (j + 1 < codes.length && codes[j + 1] === codes[j] + 1 && j + 1 - i < 31) j++;
      const data = [];
      for (const c of codes.slice(i, j + 1)) for (const b of glyphs.get(c)) data.push(base === CHARSET_ADDR ? b : b ^ 0xFF);
      out.push(...encodePoke(base + codes[i] * 8, data));
      i = j + 1;
    }
  }
  return out;
}
