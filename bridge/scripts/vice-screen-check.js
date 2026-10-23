// Runs the C64 client (build/petty.prg) in VICE and checks each of its screens against the bridge's reference
// decoder: random frames (screens, changes, a scroll, colours, underline, glyphs, sprites) go to both, and what the
// client drew (the screen or bitmap, its colours, the font, the sprites) must be what the decoder's state says, drawn
// with the same fonts. Also checks the switching: MODE gets HELLO_ON and MODES back, a display it has no screen for
// leaves it where it is, and a screen comes back right after another has used its memory. This script is the
// bridge: VICE's SwiftLink dials it. Needs x64sc.
//
// usage: node scripts/vice-screen-check.js [--keep] [prg]
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { MSG, OP, DISPLAY, Decoder, encodeFrame, encodeReset, HIRES_UNDERLINE } from '../src/protocol.js';
import { CUSTOM_GLYPHS } from '../src/glyphs.js';
import { parseCharset, charsetCommands } from '../src/charset.js';
import { FONT4 } from '../src/font4x8.js';
import { FONT6 } from '../src/font6x8.js';
import { startVice, checks } from './vice.js';

const { values: opt, positionals } = parseArgs({ allowPositionals: true, options: { keep: { type: 'boolean', default: false } } });
const prg = resolve(positionals[0] ?? fileURLToPath(new URL('../../build/petty.prg', import.meta.url)));
const log = (...a) => console.error('[vice-screen]', ...a);
const { check, done } = checks(log);
const MODES_MASK = 0x80 | 1 << DISPLAY.C64.id | 1 << DISPLAY.C64_80.id | 1 << DISPLAY.C64_HIRES.id | 1 << DISPLAY.C64_53.id;
const BORDER = 5, BG = 6;

// --- the frames ------------------------------------------------------------------

let seed = 12345;
const rnd = n => (seed = (seed * 1103515245 + 12345) & 0x7fffffff, (seed >> 8) % n);

// A random screen for display d, of glyphs (mostly letters and spaces, so runs and repeats happen) and colours. On
// the soft screens each group of cells that share a colour gets one, as the bridge makes it (soft80.js); underline
// is any character's own.
function randomScreen(d) {
  const cells = d.cols * d.rows, group = d.quad ? 4 : d.pair ? 2 : 1;
  const want = { glyph: new Int32Array(cells), color: new Int16Array(cells) };
  let g = 1, c = 1;
  for (let i = 0; i < cells; i++) {
    if (rnd(4) === 0) g = rnd(5) === 0 ? 32 : rnd(256);
    if (rnd(6) === 0 && (i % d.cols) % group === 0) c = d.hires ? rnd(256) : rnd(16);
    want.glyph[i] = g;
    want.color[i] = c | ((d.hires || d.underline) && rnd(8) === 0 ? HIRES_UNDERLINE : 0);
  }
  return want;
}

const randomSprites = () => Array.from({ length: 8 }, () => rnd(3) === 0 ? null
  : { col: rnd(70), row: rnd(24), color: rnd(16), data: Array.from({ length: 63 }, () => rnd(256)) });

// A full reset, changes, a scroll, more changes; glyphs 128-255 first on the hi-res screen; sprites on the soft ones.
function framesFor(d) {
  const frames = [];
  const shape = { cols: d.cols, rows: d.rows, hires: d.hires, underline: d.underline };
  if (d.hires) {
    const defs = [];
    for (let code = 128; code < 256; code++) defs.push(OP.GLYPH, code, 0, ...Array.from({ length: 8 }, () => rnd(256)));
    frames.push([...defs, OP.FRAME]);
  }
  let want = { ...shape, ...randomScreen(d) };
  if (d.pair || d.quad) want.sprites = randomSprites();
  let { bytes, state } = encodeReset(want, BORDER, BG, d.hires ? 0x1F : 14);
  frames.push(bytes);
  for (let k = 0; k < 4; k++) {
    const next = { ...shape, glyph: want.glyph.slice(), color: want.color.slice() };
    const fresh = randomScreen(d);
    if (k === 2) { // scrolled up by 3, with new rows at the bottom
      next.glyph.copyWithin(0, 3 * d.cols);
      next.color.copyWithin(0, 3 * d.cols);
      next.glyph.set(fresh.glyph.subarray(0, 3 * d.cols), (d.rows - 3) * d.cols);
      next.color.set(fresh.color.subarray(0, 3 * d.cols), (d.rows - 3) * d.cols);
    } else {
      // whole rows of new screen, so groups keep one colour
      for (let n = 0; n < 6; n++) {
        const y = rnd(d.rows);
        next.glyph.set(fresh.glyph.subarray(y * d.cols, (y + 1) * d.cols), y * d.cols);
        next.color.set(fresh.color.subarray(y * d.cols, (y + 1) * d.cols), y * d.cols);
      }
    }
    if (d.pair || d.quad) next.sprites = randomSprites();
    ({ bytes, state } = encodeFrame(state, next));
    if (k === 2) assert.ok(bytes.includes(OP.SCROLL), 'the scroll frame scrolls');
    frames.push(bytes);
    want = next;
  }
  return frames;
}

// --- what each screen should hold --------------------------------------------------

const bits = row => [...row].reduce((v, ch) => (v << 1) | (ch === '#' ? 1 : 0), 0);

// The 8x8 font of screen codes 0-127: the ROM's lowercase half, the custom glyphs over it.
function font8(rom) {
  const f = Array.from({ length: 128 }, (_, c) => [...rom.subarray(0x800 + c * 8, 0x800 + c * 8 + 8)]);
  for (const [slot, , rows] of CUSTOM_GLYPHS) f[slot] = rows.map(bits);
  return f;
}

const same = (got, want, what) => {
  const i = got.findIndex((v, k) => v !== want[k]);
  if (i >= 0) throw new Error(`${what}: at ${i}, ${got[i]}, not ${want[i]} (${got.filter((v, k) => v !== want[k]).length} differ)`);
};

function checkText(m, dec, font) {
  const charset = [];
  for (let c = 0; c < 256; c++) for (let r = 0; r < 8; r++) charset.push(c < 128 ? font[c][r] : ~font[c - 128][r] & 255);
  same([...m.ram.subarray(0x4000, 0x4800)], charset, 'character set');
  same([...m.ram.subarray(0x5C00, 0x5C00 + 1000)], [...dec.glyph], 'screen codes');
  same([...m.io.subarray(0x800, 0x800 + 1000)].map(v => v & 15), [...dec.color].map(v => v & 15), 'colours');
  assert.deepEqual([m.io[0x20] & 15, m.io[0x21] & 15], [dec.border & 15, dec.bg & 15], 'border and background');
}

function checkHires(m, dec, font) {
  const glyphRows = c => (c < 128 ? font[c] : [...(dec.glyphs.get(c) ?? new Uint8Array(8))]);
  const table = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 256; c++) table.push(glyphRows(c)[r]);
  same([...m.ram.subarray(0x4000, 0x4800)], table, 'font');
  const bitmap = [];
  for (let i = 0; i < 1000; i++) {
    const rows = glyphRows(dec.glyph[i]);
    for (let r = 0; r < 8; r++) bitmap.push(r === 7 && dec.color[i] & HIRES_UNDERLINE ? 255 : rows[r]);
  }
  same([...m.ram.subarray(0x6000, 0x6000 + 8000)], bitmap, 'bitmap');
  same([...m.ram.subarray(0x5C00, 0x5C00 + 1000)], [...dec.color].map(v => v & 255), 'colours');
}

// The soft screens: each character's pixels (`width` wide, 128-255 inverse), underline its bottom row; a cell's
// colour is its group's, where the group shows any character; sprites as SPRITE put them.
function checkSoft(m, dec, d) {
  const width = d.quad ? 6 : 4, FONT = d.quad ? FONT6 : FONT4, mask = (1 << width) - 1;
  const bitmap = new Array(8000).fill(0);
  for (let y = 0; y < 25; y++) {
    for (let c = 0; c < d.cols; c++) {
      const i = y * d.cols + c, g = dec.glyph[i];
      for (let r = 0; r < 8; r++) {
        let px = FONT[g & 127][r];
        if (g & 128) px = ~px & mask;
        if (r === 7 && dec.color[i] & HIRES_UNDERLINE) px = mask;
        for (let b = 0; b < width; b++) {
          if (!(px >> (width - 1 - b) & 1)) continue;
          const x = c * width + b;
          bitmap[y * 320 + (x >> 3) * 8 + r] |= 0x80 >> (x & 7);
        }
      }
    }
  }
  same([...m.ram.subarray(0x6000, 0x6000 + 8000)], bitmap, 'bitmap');
  // The columns whose characters colour each cell: at 80 columns its two; at 53 the ones that touch it (a group's
  // first cell has phases 0 and 1, its second 1 and 2, its third 2 and 3; cell 39, column 52).
  const touching = cell => (d.quad ? (cell === 39 ? [52] : [[0, 1], [1, 2], [2, 3]][cell % 3].map(p => Math.floor(cell / 3) * 4 + p))
    : [2 * cell, 2 * cell + 1]);
  for (let y = 0; y < 25; y++) {
    for (let cell = 0; cell < 40; cell++) {
      const shown = touching(cell).find(c => dec.glyph[y * d.cols + c] !== 32);
      if (shown === undefined) continue; // only spaces: the colour of whatever was there before
      const want = (dec.color[y * d.cols + shown] & 15) << 4 | dec.bg & 15;
      assert.equal(m.ram[0x5C00 + y * 40 + cell], want, `colour of cell ${cell} of row ${y}`);
    }
  }
  for (let n = 0; n < 8; n++) {
    const s = dec.sprites[n];
    assert.equal(m.io[0x15] >> n & 1, s ? 1 : 0, `sprite ${n} on`);
    if (!s) continue;
    const x = 24 + s.col * width;
    assert.deepEqual([m.io[n * 2] | (m.io[0x10] >> n & 1) << 8, m.io[n * 2 + 1], m.io[0x27 + n] & 15], [x, 50 + s.row * 8, s.color], `sprite ${n}`);
    same([...m.ram.subarray(0x5800 + n * 64, 0x5800 + n * 64 + 63)], [...s.data], `sprite ${n}'s data`);
    assert.equal(m.ram[0x5FF8 + n], 0x60 + n, `sprite ${n}'s pointer`);
  }
}

// --- the checks ------------------------------------------------------------------

const ORDER = [DISPLAY.C64_80, DISPLAY.C64, DISPLAY.C64_53, DISPLAY.C64_HIRES];
const VIC = { [DISPLAY.C64.id]: [0x1B, 0xC8, 0x70, 2] }; // $D011, $D016, $D018 (bit 0 off), the VIC's bank
const vicOf = io => [io[0x11] & 0x7F, io[0x16], io[0x18] & 0xFE, io[0xD00] & 3];

const c = await startVice(prg, { keep: opt.keep, log });
const mode = async d => {
  c.sock.write(Buffer.from([OP.MODE, d.id]));
  assert.deepEqual(await c.read(4, 'HELLO_ON'), [MSG.HELLO_ON, d === DISPLAY.C128 ? last.id : d.id, MSG.MODES, MODES_MASK]);
};
let last = DISPLAY.C64_HIRES, font = null;
const draw = async d => {
  const dec = new Decoder(d.cols, d.rows);
  for (const f of framesFor(d)) { dec.feed(f); await c.frame(f); }
  const m = await c.machine();
  if (!font) {
    await c.monitor(['bank rom', 'bsave "rom.bin" 0 d000 dfff']);
    font = font8(readFileSync(join(c.work, 'rom.bin')));
    rmSync(join(c.work, 'rom.bin'));
  }
  return { m, dec };
};
try {
  await check('it starts on hi-res and says what it can switch to', async () => {
    assert.deepEqual(await c.read(4, 'HELLO_ON'), [MSG.HELLO_ON, DISPLAY.C64_HIRES.id, MSG.MODES, MODES_MASK]);
  });
  for (const d of ORDER) {
    await check(`${d.name}: MODE switches, and the screen is what the decoder says`, async () => {
      await mode(d);
      last = d;
      const { m, dec } = await draw(d);
      assert.deepEqual(vicOf(m.io), VIC[d.id] ?? [0x3B, 0xC8, 0x78, 2], 'the VIC set-up');
      if (d === DISPLAY.C64) checkText(m, dec, font);
      else if (d.hires) checkHires(m, dec, font);
      else checkSoft(m, dec, d);
      if (!d.pair && !d.quad) assert.equal(m.io[0x15], 0, 'no sprites left on from an earlier screen');
    });
  }
  await check('a display it has no screen for (the C128\'s) leaves it on the one it is on', async () => {
    await mode(DISPLAY.C128);
  });
  await check('the text screen again, after the soft 53-column one used its font\'s memory', async () => {
    await mode(DISPLAY.C64_53);
    await mode(DISPLAY.C64);
    last = DISPLAY.C64;
    const { m, dec } = await draw(DISPLAY.C64);
    checkText(m, dec, font);
  });
  await check('--charset on the text screen: the glyph and its inverse in its character set, and it carries on', async () => {
    const WALL = ['########', '#...#...', '########', '..#...#.', '########', '#...#...', '########', '..#...#.'];
    const cs = parseCharset({ '#': WALL });
    await c.frame([...charsetCommands(cs, DISPLAY.C64), OP.GOTO, 0, 0, OP.PUT, 1, 35, OP.FRAME]);
    const m = await c.machine();
    const rows = WALL.map(bits);
    assert.deepEqual([...m.ram.subarray(0x4000 + 35 * 8, 0x4000 + 36 * 8)], rows);
    assert.deepEqual([...m.ram.subarray(0x4400 + 35 * 8, 0x4400 + 36 * 8)], rows.map(b => b ^ 0xFF));
    assert.equal(m.ram[0x5C00], 35, 'and the screen still takes characters');
  });
} finally { c.stop(); }
done();
