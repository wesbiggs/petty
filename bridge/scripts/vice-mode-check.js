// Runs the combined C64 client (build/pettyall.prg) in VICE and checks each of its screens against the
// client that has only that screen (petty.prg, pettyhires.prg, petty80.prg, petty53.prg): both get the same
// frames (random screens, scrolls, colours, glyphs, sprites), and what they drew (the screen or bitmap, its
// colours, the font tables, the sprites) must be the same bytes. Also checks the switching itself: MODE gets
// HELLO_ON and MODES back, and a display it has no screen for leaves it where it is. This script is the bridge:
// VICE's SwiftLink dials it. Needs x64sc.
//
// usage: node scripts/vice-mode-check.js [--keep] [build dir]
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { MSG, OP, DISPLAY, ScreenState, encodeFrame, encodeReset, HIRES_UNDERLINE } from '../src/protocol.js';

const { values: opt, positionals } = parseArgs({ allowPositionals: true, options: { keep: { type: 'boolean', default: false } } });
const build = resolve(positionals[0] ?? fileURLToPath(new URL('../../build', import.meta.url)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.error('[vice-mode]', ...a);
const freePort = () => new Promise((ok, fail) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }).on('error', fail); });
const MODES_MASK = 0x80 | 1 << DISPLAY.C64.id | 1 << DISPLAY.C64_80.id | 1 << DISPLAY.C64_HIRES.id | 1 << DISPLAY.C64_53.id;

// --- a client in VICE, with us as its bridge -----------------------------------

async function startVice(prg) {
  const work = mkdtempSync(join(tmpdir(), 'petty-mode-'));
  copyFileSync(prg, join(work, 'petty.prg'));
  const linkPort = await freePort(), monPort = await freePort();
  const c = { rx: [], sock: null, work };
  const waiters = [];
  c.link = net.createServer(s => {
    c.sock = s;
    s.on('data', d => { c.rx.push(...d); for (const w of [...waiters]) w(); });
  }).listen(linkPort, '127.0.0.1');
  c.waitFor = async (pred, what, ms = 20000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const r = pred();
      if (r) return r;
      await new Promise(res => { waiters.push(res); setTimeout(res, 50); });
      waiters.length = 0;
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  // The next n bytes from the client.
  c.read = async (n, what) => { await c.waitFor(() => c.rx.length >= n, what); return c.rx.splice(0, n); };
  c.vice = spawn('x64sc', [
    '-autostartprgmode', '1', '-autostart', 'petty.prg',
    '-acia1', '-acia1mode', '1', '-acia1base', '0xDE00', '-acia1irq', '1', '-myaciadev', '0',
    '-rsdev1', `127.0.0.1:${linkPort}`, '+rsdev1ip232', '-rsdev1baud', '38400',
    '-sound', '-sounddev', 'dummy',
    '-remotemonitor', '-remotemonitoraddress', `ip4://127.0.0.1:${monPort}`,
  ], { cwd: work, stdio: 'ignore' });
  c.vice.on('error', e => { log(`can't run x64sc: ${e.message}`); process.exit(2); });
  c.monitor = async cmds => {
    const s = net.connect(monPort, '127.0.0.1');
    await new Promise((ok, fail) => s.once('connect', ok).once('error', fail));
    let text = '';
    s.on('data', d => { text += d; });
    const prompt = async () => {
      for (let t = 0; t < 100 && !/\(C:\$[0-9a-f]{4}\) $/i.test(text); t++) await sleep(50);
      text = '';
    };
    for (const cmd of [...cmds, 'x']) { await prompt(); s.write(cmd + '\n'); }
    await sleep(100);
    s.destroy();
  };
  // All of RAM, and the I/O area (VIC, SID, colour RAM).
  c.machine = async () => {
    await c.monitor(['bank io', 'bsave "io.bin" 0 d000 dfff', 'bank ram', 'bsave "ram.bin" 0 0000 ffff']);
    const io = readFileSync(join(work, 'io.bin')), ram = readFileSync(join(work, 'ram.bin'));
    rmSync(join(work, 'io.bin')); rmSync(join(work, 'ram.bin'));
    return { io, ram };
  };
  // A frame (ending in FRAME), and its ACK.
  c.frame = async bytes => {
    c.sock.write(Buffer.from(bytes));
    const ack = await c.read(1, 'ACK');
    assert.deepEqual(ack, [MSG.ACK], 'ACK');
  };
  c.stop = () => {
    if (opt.keep) return log(`kept ${work}`);
    c.vice.kill();
    c.link.close();
    rmSync(work, { recursive: true, force: true });
  };
  return c;
}

// --- the frames ------------------------------------------------------------------

let seed = 12345;
const rnd = n => (seed = (seed * 1103515245 + 12345) & 0x7fffffff, (seed >> 8) % n);

// A random screen for display d, of glyphs (mostly letters and spaces, so runs and repeats happen) and colours.
function randomScreen(d) {
  const cells = d.cols * d.rows;
  const want = { glyph: new Int32Array(cells), color: new Int16Array(cells) };
  let g = 1, c = 1;
  for (let i = 0; i < cells; i++) {
    if (rnd(4) === 0) g = rnd(5) === 0 ? 32 : rnd(256);
    if (rnd(6) === 0) c = d.hires ? rnd(256) | (rnd(4) === 0 ? HIRES_UNDERLINE : 0) : rnd(16);
    want.glyph[i] = g;
    want.color[i] = c;
  }
  return want;
}

// Sprites over the soft 80- and 53-column screens: some on, some off.
const randomSprites = () => Array.from({ length: 8 }, () => rnd(3) === 0 ? null
  : { col: rnd(70), row: rnd(24), color: rnd(16), data: Array.from({ length: 63 }, () => rnd(256)) });

// The same frames for both clients of display d: a full reset, changes, a scroll, more changes; and, on the
// hi-res screen, glyphs 128-255 defined first.
function framesFor(d) {
  const frames = [];
  if (d.hires) {
    const defs = [];
    for (let code = 128; code < 256; code++) defs.push(OP.GLYPH, code, 0, ...Array.from({ length: 8 }, () => rnd(256)));
    frames.push([...defs, OP.FRAME]);
  }
  let want = randomScreen(d);
  if (d.pair || d.quad) want.sprites = randomSprites();
  let { bytes, state } = encodeReset({ ...want, cols: d.cols, rows: d.rows, hires: d.hires }, 5, 6, d.hires ? 0x1F : 14);
  frames.push(bytes);
  for (let k = 0; k < 4; k++) {
    const next = { glyph: want.glyph.slice(), color: want.color.slice() };
    if (k === 2) { // scrolled up by 3, with new rows at the bottom
      next.glyph.copyWithin(0, 3 * d.cols);
      next.color.copyWithin(0, 3 * d.cols);
      const fresh = randomScreen(d);
      next.glyph.set(fresh.glyph.subarray(0, 3 * d.cols), (d.rows - 3) * d.cols);
      next.color.set(fresh.color.subarray(0, 3 * d.cols), (d.rows - 3) * d.cols);
    } else {
      const fresh = randomScreen(d);
      for (let n = 0; n < 300; n++) { const i = rnd(d.cols * d.rows); next.glyph[i] = fresh.glyph[i]; next.color[i] = fresh.color[i]; }
    }
    if (d.pair || d.quad) next.sprites = randomSprites();
    ({ bytes, state } = encodeFrame(state, next));
    if (k === 2) assert.ok(bytes.includes(OP.SCROLL), 'the scroll frame scrolls');
    frames.push(bytes);
    want = next;
  }
  return frames;
}

// What to compare, as [name, address in the single-screen client, in the combined one, length], RAM unless io.
const REGIONS = {
  [DISPLAY.C64.id]: [['screen codes', 0x0400, 0x5C00, 1000], ['colours', 0x800, 0x800, 1000, 'io', 15], ['font', 0x3800, 0x4000, 0x800],
    ['border and background', 0x20, 0x20, 2, 'io', 15]],
  [DISPLAY.C64_HIRES.id]: [['bitmap', 0x6000, 0x6000, 8000], ['colours', 0x5C00, 0x5C00, 1000], ['font', 0x4000, 0x4000, 0x800],
    ['border', 0x20, 0x20, 1, 'io', 15]],
  [DISPLAY.C64_80.id]: [['bitmap', 0x6000, 0x6000, 8000], ['colours', 0x5C00, 0x5C00, 1000], ['font tables', 0x4000, 0x4000, 0x1000],
    ['sprite data', 0x5000, 0x5000, 0x200, 'sprites'], ['sprite pointers', 0x5FF8, 0x5FF8, 8], ['sprite registers', 0x00, 0x00, 0x11, 'io'],
    ['sprites on', 0x15, 0x15, 1, 'io'], ['sprite colours', 0x27, 0x27, 8, 'io', 15], ['border', 0x20, 0x20, 1, 'io', 15]],
  [DISPLAY.C64_53.id]: [['bitmap', 0x6000, 0x6000, 8000], ['colours', 0x5C00, 0x5C00, 1000], ['font tables', 0x2000, 0x9000, 0x3000],
    ['sprite data', 0x5000, 0x5000, 0x200, 'sprites'], ['sprite pointers', 0x5FF8, 0x5FF8, 8], ['sprite registers', 0x00, 0x00, 0x11, 'io'],
    ['sprites on', 0x15, 0x15, 1, 'io'], ['sprite colours', 0x27, 0x27, 8, 'io', 15], ['border', 0x20, 0x20, 1, 'io', 15]],
};
// The VIC's set-up on the combined client's screens: $D011, $D016, $D018, and the bank (CIA 2 port A, bits 0-1:
// 2 is the second bank).
const VIC = { [DISPLAY.C64.id]: [0x1B, 0xC8, 0x70, 2], [DISPLAY.C64_HIRES.id]: [0x3B, 0xC8, 0x78, 2],
  [DISPLAY.C64_80.id]: [0x3B, 0xC8, 0x78, 2], [DISPLAY.C64_53.id]: [0x3B, 0xC8, 0x78, 2] };
const PRG = { [DISPLAY.C64.id]: 'petty.prg', [DISPLAY.C64_HIRES.id]: 'pettyhires.prg', [DISPLAY.C64_80.id]: 'petty80.prg', [DISPLAY.C64_53.id]: 'petty53.prg' };

// Sprite data is compared for the sprites that are on, and only their 63 bytes: the rest is what VICE put in RAM
// at power-on, which can differ between two runs.
const slice = (m, [, a, b, n, where, mask = 0xFF], combined) => {
  const at = combined ? b : a;
  if (where === 'sprites') return [...m.ram.subarray(at, at + n)].map((v, k) => m.io[0x15] & 1 << (k >> 6) && (k & 63) < 63 ? v : -1);
  return [...m[where ?? 'ram'].subarray(at, at + n)].map(v => v & mask);
};

// The region in the combined client's machine is as in the reference's; else says where it first differs.
function same(m, ref, region) {
  const got = slice(m, region, true), want = slice(ref, region, false);
  const i = got.findIndex((v, k) => v !== want[k]);
  if (i >= 0) {
    const at = a => `$${(a + i).toString(16)}`;
    throw new Error(`${region[0]}: at ${at(region[2])} (${at(region[1])} in the reference) ${got[i]}, not ${want[i]}; ${got.filter((v, k) => v !== want[k]).length} bytes differ`);
  }
}

const results = [];
async function check(name, fn) {
  try { await fn(); results.push([name, true]); log(`ok   ${name}`); }
  catch (e) { results.push([name, false]); log(`FAIL ${name}: ${e.message}`); }
}

const ORDER = [DISPLAY.C64_80, DISPLAY.C64, DISPLAY.C64_53, DISPLAY.C64_HIRES];
const frames = Object.fromEntries(ORDER.map(d => [d.id, framesFor(d)]));

// The single-screen clients first: what each drew.
const reference = {};
for (const d of ORDER) {
  await check(`${d.name}: the single-screen client draws the frames`, async () => {
    const c = await startVice(join(build, PRG[d.id]));
    try {
      await c.read(d === DISPLAY.C64 ? 1 : 2, 'HELLO');
      for (const f of frames[d.id]) await c.frame(f);
      reference[d.id] = await c.machine();
    } finally { c.stop(); }
  });
}

const c = await startVice(join(build, 'pettyall.prg'));
try {
  await check('the combined client starts on hi-res and says what it can switch to', async () => {
    assert.deepEqual(await c.read(4, 'HELLO_ON'), [MSG.HELLO_ON, DISPLAY.C64_HIRES.id, MSG.MODES, MODES_MASK]);
  });
  for (const d of ORDER) {
    await check(`${d.name}: MODE switches, and the screen draws as the single-screen client's does`, async () => {
      c.sock.write(Buffer.from([OP.MODE, d.id]));
      assert.deepEqual(await c.read(4, 'HELLO_ON'), [MSG.HELLO_ON, d.id, MSG.MODES, MODES_MASK]);
      for (const f of frames[d.id]) await c.frame(f);
      const m = await c.machine();
      const want = reference[d.id];
      assert.ok(want, 'no reference');
      for (const region of REGIONS[d.id]) same(m, want, region);
      assert.deepEqual([m.io[0x11] & 0x7F, m.io[0x16], m.io[0x18] & 0xFE, m.io[0xD00] & 3], VIC[d.id], 'the VIC set-up');
      if (!d.pair && !d.quad) assert.equal(m.io[0x15], 0, 'no sprites left on from an earlier screen');
    });
  }
  await check('a display it has no screen for (the C128\'s) leaves it on the one it is on', async () => {
    c.sock.write(Buffer.from([OP.MODE, DISPLAY.C128.id]));
    assert.deepEqual(await c.read(4, 'HELLO_ON'), [MSG.HELLO_ON, DISPLAY.C64_HIRES.id, MSG.MODES, MODES_MASK]);
    const m = await c.machine();
    same(m, reference[DISPLAY.C64_HIRES.id], REGIONS[DISPLAY.C64_HIRES.id][0]); // the bitmap is as it was
  });
  await check('back and forth: the text screen again after the soft 53-column one', async () => {
    for (const d of [DISPLAY.C64_53, DISPLAY.C64]) {
      c.sock.write(Buffer.from([OP.MODE, d.id]));
      assert.deepEqual(await c.read(4, 'HELLO_ON'), [MSG.HELLO_ON, d.id, MSG.MODES, MODES_MASK]);
    }
    for (const f of frames[DISPLAY.C64.id]) await c.frame(f);
    const m = await c.machine();
    for (const region of REGIONS[DISPLAY.C64.id]) same(m, reference[DISPLAY.C64.id], region);
  });
} finally { c.stop(); }

const failed = results.filter(([, ok]) => !ok).length;
log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
