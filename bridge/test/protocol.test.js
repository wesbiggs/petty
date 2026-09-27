import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DISPLAY, OP, Decoder, encodeFrame, encodeReset, sameLook } from '../src/protocol.js';
import { toScreenCode, INVERSE } from '../src/glyphs.js';
import { keyToBytes, MATRIX, SHIFT, CTRL, CBM, ALT } from '../src/keymap.js';
import { VIC, RGBI } from '../src/colors.js';

const SPACE = 32;

function blank({ cols, rows } = DISPLAY.C64) {
  const glyph = new Int16Array(cols * rows).fill(SPACE);
  return { cols, rows, glyph, color: new Int16Array(cols * rows).fill(15) };
}

function text(screen, row, col, s, color = 15) {
  [...s].forEach((ch, k) => {
    screen.glyph[row * screen.cols + col + k] = toScreenCode(ch);
    screen.color[row * screen.cols + col + k] = color;
  });
}

function assertShows(dec, want) {
  for (let i = 0; i < want.glyph.length; i++) {
    assert.equal(dec.glyph[i], want.glyph[i], `glyph at ${i}`);
    assert.ok(sameLook(want.glyph[i], dec.color[i], want.color[i]), `color at ${i}: ${dec.color[i]} vs ${want.color[i]}`);
  }
}

test('reset then incremental frames decode to the wanted screen', () => {
  const dec = new Decoder();
  let want = blank();
  text(want, 0, 0, '╭──────╮', 3);
  text(want, 1, 0, '│ ❯ hi │', 1);
  let { bytes, state } = encodeReset(want);
  dec.feed(bytes);
  assertShows(dec, want);

  text(want, 1, 5, 'yo', 7);
  ({ bytes, state } = encodeFrame(state, want));
  dec.feed(bytes);
  assertShows(dec, want);
  assert.ok(bytes.length < 12, `small update, got ${bytes.length} bytes`);

  ({ bytes } = encodeFrame(state, want));
  assert.deepEqual(bytes, [OP.FRAME], 'no change = empty frame');
});

test('scrolling output uses SCROLL', () => {
  const dec = new Decoder();
  const want = blank();
  for (let r = 0; r < 25; r++) text(want, r, 0, `line ${r} of the transcript`);
  let { bytes, state } = encodeReset(want);
  dec.feed(bytes);

  const next = blank();
  for (let r = 0; r < 25; r++) text(next, r, 0, `line ${r + 3} of the transcript`);
  ({ bytes, state } = encodeFrame(state, next));
  dec.feed(bytes);
  assertShows(dec, next);
  assert.ok(bytes.includes(OP.SCROLL));
  assert.ok(bytes.length < 120, `scroll frame ${bytes.length} bytes`);
});

for (const display of Object.values(DISPLAY)) test(`random frames stay in sync (${display.name})`, () => {
  let seed = 1;
  const rand = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const dec = new Decoder(display.cols, display.rows);
  let want = blank(display);
  let { bytes, state } = encodeReset(want);
  dec.feed(bytes);
  for (let f = 0; f < 200; f++) {
    want = { ...want, glyph: want.glyph.slice(), color: want.color.slice() };
    for (let k = rand(60); k > 0; k--) {
      const i = rand(want.glyph.length);
      want.glyph[i] = rand(4) ? rand(256) : SPACE;
      // Underline (C128) shows on spaces too.
      want.color[i] = rand(16) | (display === DISPLAY.C128 && !rand(4) ? 0x20 : 0);
    }
    ({ bytes, state } = encodeFrame(state, want));
    dec.feed(bytes);
    assertShows(dec, want);
  }
});

test('80-column screen scrolls and addresses the right half', () => {
  const dec = new Decoder(80, 25);
  const want = blank(DISPLAY.C128);
  for (let r = 0; r < 25; r++) text(want, r, 50, `right side ${r}`);
  let { bytes, state } = encodeReset(want);
  dec.feed(bytes);
  assertShows(dec, want);

  const next = blank(DISPLAY.C128);
  for (let r = 0; r < 25; r++) text(next, r, 50, `right side ${r + 2}`);
  text(next, 24, 79, 'x');
  ({ bytes, state } = encodeFrame(state, next));
  dec.feed(bytes);
  assertShows(dec, next);
  assert.ok(bytes.includes(OP.SCROLL));

  assert.throws(() => encodeFrame(state, blank()), /size/);
});

test('underlined spaces are drawn, plain spaces keep any colour', () => {
  const dec = new Decoder(80, 25);
  const want = blank(DISPLAY.C128);
  text(want, 0, 0, 'a b', 14 | 0x20); // underlined, space included
  text(want, 0, 3, ' c', 14);
  let { bytes, state } = encodeReset(want);
  dec.feed(bytes);
  assertShows(dec, want);
  assert.equal(dec.color[1], 14 | 0x20, 'underlined space');
  assert.equal(dec.color[3] & 0x20, 0, 'space after the underlined word');
});

test('glyph mapping', () => {
  assert.equal(toScreenCode('a'), 1);
  assert.equal(toScreenCode('A'), 65);
  assert.equal(toScreenCode('╭'), 97);
  assert.equal(toScreenCode('⎿'), toScreenCode('└'));
  assert.equal(toScreenCode('█'), SPACE | INVERSE);
  assert.equal(toScreenCode('é'), toScreenCode('e'));
  assert.equal(toScreenCode('🦀'), toScreenCode('?'));
});

test('keymap', () => {
  const k = name => MATRIX.indexOf(name);
  assert.equal(keyToBytes(k('a'), 0), 'a');
  assert.equal(keyToBytes(k('a'), SHIFT), 'A');
  assert.equal(keyToBytes(k('c'), CTRL), '\x03');
  assert.equal(keyToBytes(k('p'), CBM), '\x1bp');
  assert.equal(keyToBytes(k('RETURN'), 0), '\r');
  assert.equal(keyToBytes(k('STOP'), 0), '\x1b');
  assert.equal(keyToBytes(k('CRSR↕'), SHIFT), '\x1b[A');
  assert.equal(keyToBytes(k('CRSR↕'), 0, { appCursor: true }), '\x1bOB');
  assert.equal(keyToBytes(k(':'), SHIFT), '[');
  assert.equal(keyToBytes(k('£'), 0), '\\');
  assert.deepEqual(keyToBytes(k('CRSR↔'), CBM), { pan: 1 });
  assert.deepEqual(keyToBytes(k('CRSR↔'), CBM | SHIFT), { pan: -1 });
});

test('C128 keys', () => {
  const k = name => MATRIX.indexOf(name);
  assert.equal(k('HELP'), 64);
  assert.equal(k('NOSCROLL'), 87);
  assert.equal(keyToBytes(k('ESC'), 0), '\x1b');
  assert.equal(keyToBytes(k('TAB'), 0), '\t');
  assert.equal(keyToBytes(k('TAB'), SHIFT), '\x1b[Z');
  assert.equal(keyToBytes(k('UP'), 0), '\x1b[A');
  assert.equal(keyToBytes(k('UP'), SHIFT), '\x1b[A', 'no SHIFT flip on the C128 cursor keys');
  assert.equal(keyToBytes(k('LEFT'), 0, { appCursor: true }), '\x1bOD');
  assert.deepEqual(keyToBytes(k('LEFT'), CBM), { pan: -1 });
  assert.equal(keyToBytes(k('KP7'), 0), '7');
  assert.equal(keyToBytes(k('ENTER'), 0), '\r');
  assert.equal(keyToBytes(k('a'), ALT), '\x1ba');
  assert.equal(keyToBytes(k('ESC'), ALT), '\x1b\x1b');
  assert.equal(keyToBytes(k('NOSCROLL'), 0), null);
});

test('palettes', () => {
  assert.equal(RGBI.fg('palette', 1), 8, 'ANSI red = VDC dark red');
  assert.equal(RGBI.fg('palette', 12), 3, 'ANSI bright blue = VDC light blue');
  assert.equal(RGBI.bg('palette', 0), null);
  assert.equal(RGBI.fg('rgb', 0xd77757), 9, 'Claude orange');
  assert.equal(VIC.fg('palette', 1), 2, 'C64 mapping unchanged');
  assert.equal(VIC.fg('rgb', 0xb1b9f9), 14, 'Claude Code blue = C64 light blue');
  assert.equal(RGBI.fg('rgb', 0xb1b9f9), 3, 'Claude Code blue = VDC light blue');
  assert.notEqual(VIC.fg('rgb', 0xa0b0e8), 15, 'a pale blue is not grey');
  assert.equal(VIC.fg('rgb', 0x999999), 15, 'greys still map to grey');
});
