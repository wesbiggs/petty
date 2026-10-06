import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DISPLAY, OP, Decoder, ScreenState, encodeFrame, encodeReset } from '../src/protocol.js';
import { GameHardware, compileScript, parseVoices, SCRIPT_BASE } from '../src/game.js';

const b64 = bytes => Buffer.from(bytes).toString('base64');

function hardware(active = true) {
  const replies = [], kicks = [];
  const g = new GameHardware({ log: () => {}, active: () => active, kick: () => kicks.push(1), reply: t => replies.push(t) });
  return { g, replies, kicks };
}

// What the client would be left with after the bytes the bridge queued.
const decode = (...queues) => {
  const d = new Decoder();
  for (const q of queues) d.feed(q);
  return d;
};

test('compileScript: loops, markers, ends', () => {
  const src = [1, 7, 9, 2, 253, 0, 5, 254];
  const { bytes, loops } = compileScript(src, 0x4100);
  assert.ok(loops);
  assert.deepEqual([...bytes], [1, 7, 9, 2, 0, 5, 254, 0x04, 0x41]);
  const plain = compileScript([0, 3, 255], 0);
  assert.equal(plain.loops, false);
  assert.deepEqual([...plain.bytes], [0, 3, 255]);
  assert.deepEqual([...compileScript([0, 1]).bytes], [0, 1, 255], 'ends if the program did not say');
  assert.throws(() => compileScript([2, 1, 2]), /inside a record/);
});

test('parseVoices', () => {
  assert.equal(parseVoices('1'), 0x7F);
  assert.equal(parseVoices('3'), 0x7F << 14);
  assert.equal(parseVoices('1+2+vol'), 0x7F | 0x7F << 7 | 1 << 24);
  assert.equal(parseVoices(undefined), 0x1FFFFFF);
  assert.equal(parseVoices('0x10'), 0x10);
  assert.throws(() => parseVoices('4'), /not 1, 2, 3/);
});

test('sprites: set, dedup, glide, hide', () => {
  const { g } = hardware();
  const shape = new Uint8Array(63).map((_, i) => i);
  g.sprite(`def;3;${b64(shape)}`);
  g.sprite('set;0;3;100;50;7;xb');
  g.sprite('set;0;3;100;50;7;xb'); // the same: nothing
  g.sprite('glide;0;2;0;10');
  g.sprite('set;0;3;120;50;7;xb'); // where the glide ends: nothing
  const d = decode(g.takePre(), g.takePost());
  assert.deepEqual([...d.shapes.get(3)], [...shape]);
  const s = d.hw[0];
  assert.equal(s.x, 124);
  assert.equal(s.y, 100);
  assert.equal(s.flags, 2 | 8 | 32);
  assert.deepEqual(s.glide, { frames: 10, dx: 2, dy: 0 });
  assert.equal(d.hw.filter(Boolean).length, 1);
  g.sprite('hide;0');
  assert.equal(decode(g.takePost()).hw[0].flags & 2, 0);
});

test('sprites: x past 255 uses bit 8', () => {
  const { g } = hardware();
  g.sprite(`def;0;${b64(new Uint8Array(63))}`);
  g.sprite('set;1;0;300;10;1');
  const s = decode(g.takePost()).hw[1];
  assert.equal(s.x, 324);
  assert.equal(s.y, 60);
});

test('bad commands are logged, not thrown', () => {
  const { g } = hardware();
  assert.equal(g.sprite('set;9;0;0;0;0'), true);
  assert.equal(g.sprite('wibble'), true);
  assert.equal(g.sid('play;0;77'), true);
  assert.ok(!decode(g.takePre(), g.takePost()).sid.some(s => s.op === 'play'));
});

test('sync waits for the glides', async () => {
  const { g, replies } = hardware();
  g.sprite(`def;0;${b64(new Uint8Array(63))}`);
  g.sprite('set;0;0;0;0;1');
  g.sprite('sync;a');
  assert.deepEqual(replies, ['\x1b]8348;sync;a\x07'], 'nothing gliding: at once');
  g.sprite('glide;0;1;1;5');
  g.sprite('sync;b');
  assert.equal(replies.length, 1);
  g.takePost();
  g.glideDone();
  assert.equal(replies.length, 2);
  assert.equal(replies[1], '\x1b]8348;sync;b\x07');
  g.dispose();
});

test('sid: scripts are uploaded once and played by number', () => {
  const { g, kicks } = hardware();
  g.sid(`def;1;${b64([2, 4, 0x10, 24, 15, 3, 254])}`);
  g.sid('play;0;1;1+2+vol');
  assert.equal(kicks.length, 1);
  const d = decode(g.takePre());
  assert.deepEqual(d.sid, [{ op: 'reset' }, { op: 'play', ch: 0, addr: SCRIPT_BASE, mask: (0x7F | 0x7F << 7 | 1 << 24) >>> 0 }], 'cleared first, once');
  const script = [...d.mem.subarray(SCRIPT_BASE, SCRIPT_BASE + 9)];
  assert.deepEqual(script, [2, 4, 0x10, 24, 15, 3, 254, 0x00, 0x40]);
  g.sid('w;24;15;4;17');
  assert.deepEqual(decode(g.takePre()).sid, [{ op: 'w', w: [[24, 15], [4, 17]] }]);
});

test('sid: a script redefined in the same room stays where it was', () => {
  const { g } = hardware();
  g.sid(`def;1;${b64([0, 1, 255])}`);
  g.sid(`def;2;${b64([0, 1, 255])}`);
  g.takePre();
  g.sid(`def;1;${b64([0, 2, 255])}`);
  g.sid('play;1;1;3');
  assert.equal(decode(g.takePre()).sid[0].addr, SCRIPT_BASE);
});

test('invalidate sends everything again; only looping music replays', () => {
  const { g } = hardware();
  g.sprite(`def;2;${b64(new Uint8Array(63).fill(7))}`);
  g.sprite('set;4;2;10;20;3');
  g.sid(`def;1;${b64([1, 4, 1, 0, 254])}`);
  g.sid(`def;2;${b64([1, 18, 33, 2, 255])}`);
  g.sid('play;0;1;1+2');
  g.sid('play;1;2;3');
  g.takePre(); g.takePost();
  g.invalidate();
  const d = decode(g.takePre(), g.takePost());
  assert.equal(d.hw[4].x, 34);
  assert.ok(d.shapes.has(2));
  assert.equal(d.sid[0].op, 'reset');
  const plays = d.sid.filter(s => s.op === 'play');
  assert.equal(plays.length, 1, 'the effect does not come back');
  assert.equal(plays[0].ch, 0);
});

test('nothing is queued for a client without them, and all of it arrives later', () => {
  let active = false;
  const g = new GameHardware({ log: () => {}, active: () => active, kick: () => {}, reply: () => {} });
  g.sprite(`def;0;${b64(new Uint8Array(63))}`);
  g.sprite('set;0;0;5;5;1');
  g.sid(`def;1;${b64([0, 1, 254])}`);
  g.sid('play;0;1');
  assert.ok(!g.pending());
  active = true;
  g.invalidate();
  const d = decode(g.takePre(), g.takePost());
  assert.ok(d.hw[0]);
  assert.equal(d.sid.filter(s => s.op === 'play').length, 1);
});

// --- MOVE ----------------------------------------------------------------------

function map(w, h, seed = 1) {
  let r = seed;
  const rnd = () => (r = (r * 1103515245 + 12345) & 0x7fffffff) >> 8;
  return Array.from({ length: h }, () => Array.from({ length: w }, () => [65 + rnd() % 20, 1 + rnd() % 15]));
}

function screenOf(m, x0, y0, view = { w: 21, h: 19 }) {
  const { cols, rows } = DISPLAY.C64;
  const glyph = new Int16Array(cols * rows).fill(32), color = new Int16Array(cols * rows).fill(15);
  for (let y = 0; y < view.h; y++) for (let x = 0; x < view.w; x++) {
    const [g, c] = m[y0 + y][x0 + x];
    glyph[y * cols + x + 1] = g;
    color[y * cols + x + 1] = c;
  }
  glyph.set([72, 80, 58], 22 * cols); // a status line that stays put
  return { cols, rows, glyph, color, move: true };
}

for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-2, 0]]) {
  test(`a map scrolled by ${dx},${dy} goes by MOVE and still draws the same screen`, () => {
    const m = map(40, 40);
    const before = screenOf(m, 5, 5), after = screenOf(m, 5 + dx, 5 + dy);
    const { state } = encodeReset(before);
    const withMove = encodeFrame(state, after);
    const plain = encodeFrame(state, { ...after, move: false });
    // (A map moving up is the full-width SCROLL's job, which was there already.)
    if (dy !== 1 || dx) assert.ok(withMove.bytes.includes(OP.MOVE), 'uses MOVE');
    assert.ok(withMove.bytes.length <= plain.bytes.length / (dy === 1 && !dx ? 1 : 2), `${withMove.bytes.length} bytes against ${plain.bytes.length}`);
    const dec = new Decoder();
    dec.feed(encodeReset(before).bytes);
    dec.feed(withMove.bytes);
    assert.deepEqual([...dec.glyph], [...after.glyph]);
    for (let i = 0; i < after.glyph.length; i++) if (after.glyph[i] !== 32) assert.equal(dec.color[i], after.color[i], `colour at ${i}`);
  });
}

test('no MOVE when nothing moved as a block', () => {
  const m = map(40, 40);
  const before = screenOf(m, 5, 5), after = screenOf(m, 5, 5);
  after.glyph[50] = 99;
  const { state } = encodeReset(before);
  assert.ok(!encodeFrame(state, after).bytes.includes(OP.MOVE));
});
