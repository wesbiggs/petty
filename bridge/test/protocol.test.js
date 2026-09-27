import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CELLS, COLS, OP, Decoder, encodeFrame, encodeReset } from '../src/protocol.js';
import { toScreenCode, INVERSE } from '../src/glyphs.js';
import { keyToBytes, MATRIX, SHIFT, CTRL, CBM } from '../src/keymap.js';

const SPACE = 32;

function blank() {
  return { glyph: new Int16Array(CELLS).fill(SPACE), color: new Int16Array(CELLS).fill(15) };
}

function text(screen, row, col, s, color = 15) {
  [...s].forEach((ch, k) => {
    screen.glyph[row * COLS + col + k] = toScreenCode(ch);
    screen.color[row * COLS + col + k] = color;
  });
}

function assertShows(dec, want) {
  for (let i = 0; i < CELLS; i++) {
    assert.equal(dec.glyph[i], want.glyph[i], `glyph at ${i}`);
    if (want.glyph[i] !== SPACE) assert.equal(dec.color[i], want.color[i], `color at ${i}`);
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

test('random frames stay in sync', () => {
  let seed = 1;
  const rand = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const dec = new Decoder();
  let want = blank();
  let { bytes, state } = encodeReset(want);
  dec.feed(bytes);
  for (let f = 0; f < 200; f++) {
    want = { glyph: want.glyph.slice(), color: want.color.slice() };
    for (let k = rand(60); k > 0; k--) {
      const i = rand(CELLS);
      want.glyph[i] = rand(4) ? rand(256) : SPACE;
      want.color[i] = rand(16);
    }
    ({ bytes, state } = encodeFrame(state, want));
    dec.feed(bytes);
    assertShows(dec, want);
  }
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
  assert.equal(keyToBytes(k('DOWN'), SHIFT), '\x1b[A');
  assert.equal(keyToBytes(k('DOWN'), 0, { appCursor: true }), '\x1bOB');
  assert.equal(keyToBytes(k(':'), SHIFT), '[');
  assert.equal(keyToBytes(k('£'), 0), '\\');
  assert.deepEqual(keyToBytes(k('RIGHT'), CBM), { pan: 1 });
  assert.deepEqual(keyToBytes(k('RIGHT'), CBM | SHIFT), { pan: -1 });
});
