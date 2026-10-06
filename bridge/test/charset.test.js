import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DISPLAY, Decoder } from '../src/protocol.js';
import { parseCharset, charsetCommands, charsFor, reservedSlots, extRedraws, CHARSET_ADDR, FIXED } from '../src/charset.js';
import { GlyphCache } from '../src/glyphcache.js';
import { EXT, EXT_GLYPHS, extendedGlyph } from '../src/extglyphs.js';
import { toScreenCode, setOverrides } from '../src/glyphs.js';

const WALL = ['########', '#...#...', '########', '..#...#.', '########', '#...#...', '########', '..#...#.'];

test('parseCharset: redraw a character, add one in a slot, and bad input', () => {
  const { chars, glyphs } = parseCharset({ '#': WALL, '': { slot: 112, rows: [1, 2, 3, 4, 5, 6, 7, 255] } });
  assert.equal(chars.size, 1);
  assert.equal(chars.get(''), 112);
  assert.deepEqual([...glyphs.get(toScreenCode('#'))], [0xFF, 0x88, 0xFF, 0x22, 0xFF, 0x88, 0xFF, 0x22]);
  assert.deepEqual([...glyphs.get(112)], [1, 2, 3, 4, 5, 6, 7, 255]);
  assert.throws(() => parseCharset({ '': WALL }), /slot/);
  assert.throws(() => parseCharset({ '█': WALL }), /inverse/);
  assert.throws(() => parseCharset({ ab: WALL }), /one character/);
  assert.throws(() => parseCharset({ '#': WALL.slice(1) }), /8 rows/);
  assert.throws(() => parseCharset({ '#': [...WALL.slice(1), '#######'] }), /8 pixels/);
  assert.throws(() => parseCharset({ '#': WALL, '': { slot: 35, rows: [0, 0, 0, 0, 0, 0, 0, 0] } }), /already/);
  assert.throws(() => parseCharset({ '': { slot: 256, rows: WALL } }), /0-255/);
});

test('charsetPokes: glyphs and their inverses land in the client\'s character RAM', () => {
  const cs = parseCharset({ '#': WALL, '$': WALL.map(r => r.split('').reverse().join('')), '': { slot: 112, rows: WALL } });
  const bytes = charsetCommands(cs, DISPLAY.C64);
  const d = new Decoder(DISPLAY.C64.cols, DISPLAY.C64.rows);
  d.feed(bytes);
  for (const [code, g] of cs.glyphs) {
    assert.deepEqual([...d.mem.subarray(CHARSET_ADDR + code * 8, CHARSET_ADDR + code * 8 + 8)], [...g]);
    assert.deepEqual([...d.mem.subarray(CHARSET_ADDR + 0x400 + code * 8, CHARSET_ADDR + 0x400 + code * 8 + 8)], [...g].map(b => b ^ 0xFF));
  }
  // '#' (35) and '$' (36) are neighbours, so each half is two commands: 35-36 and 112
  assert.equal(bytes.length, 2 * (4 + 16 + 4 + 8));
  assert.equal(d.mem[CHARSET_ADDR + 37 * 8], 0, 'next slot untouched');
});

test('setOverrides: a new character draws as its slot, and goes away again', () => {
  const { chars } = parseCharset({ '': { slot: 112, rows: WALL } });
  assert.equal(toScreenCode(''), toScreenCode('?'));
  setOverrides(chars);
  assert.equal(toScreenCode(''), 112);
  setOverrides(null);
  assert.equal(toScreenCode(''), toScreenCode('?'));
});

test('hi-res: GLYPH for every slot, 128-255 kept out of the cache, ext glyphs redrawn', () => {
  const H = DISPLAY.C64_HIRES;
  const cs = parseCharset({ '#': WALL, '\uE000': { slot: 200, rows: WALL }, '●': [1, 2, 3, 4, 5, 6, 7, 8] });
  const d = new Decoder(H.cols, H.rows);
  d.feed(charsetCommands(cs, H));
  assert.deepEqual([...d.glyphs.get(toScreenCode('#'))], [...cs.glyphs.get(35)]);
  assert.deepEqual([...d.glyphs.get(200)], [...WALL.map(r => parseInt(r.replaceAll('#', '1').replaceAll('.', '0'), 2))]);
  assert.equal(charsFor(cs, H).get('\uE000'), FIXED + 200);
  assert.deepEqual(reservedSlots(cs, H), [200]);
  assert.equal(charsFor(cs, DISPLAY.C64).size, 0, 'slot 200 is not for the text client');
  assert.equal(charsetCommands(cs, DISPLAY.C128).length, 0);

  const cache = new GlyphCache(H, reservedSlots(cs, H), extRedraws(cs, H));
  assert.equal(cache.slots.includes(200), false);
  const g = extendedGlyph('●');
  const want = { glyph: Int32Array.from([FIXED + 200, g, 65]), color: new Int16Array(3) };
  const out = cache.place(want, null);
  assert.deepEqual([...want.glyph].slice(0, 1), [200]);
  assert.equal(want.glyph[2], 65);
  assert.deepEqual(out.slice(3), [1, 2, 3, 4, 5, 6, 7, 8], 'the redrawn ● is what is loaded');
  assert.notDeepEqual(EXT_GLYPHS[g - EXT].data.slice(0, 2), [1, 2]);
});

test('a fixed slot passes through the cache even when no extended glyph is on screen', () => {
  const cache = new GlyphCache(DISPLAY.C64_HIRES, [200]);
  const want = { glyph: Int32Array.from([FIXED + 200, 32]), color: new Int16Array(2) };
  assert.deepEqual(cache.place(want, null), []);
  assert.deepEqual([...want.glyph], [200, 32]);
});
