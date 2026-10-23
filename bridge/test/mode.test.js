// A client that can switch displays (MODES, MODE): who picks the display, and what the program is told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Decoder, DISPLAY, MSG, OP, displayById, parseMode, pickDisplay } from '../src/protocol.js';
import { keyToBytes, MATRIX, CBM, SHIFT } from '../src/keymap.js';

const BRIDGE = fileURLToPath(new URL('../src/bridge.js', import.meta.url));
const PETTY_MODE = fileURLToPath(new URL('../bin/petty-mode', import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (pred, ms = 6000) => { for (let t = 0; t < ms && !pred(); t += 50) await sleep(50); return pred(); };
const C64S = [DISPLAY.C64, DISPLAY.C64_HIRES, DISPLAY.C64_80, DISPLAY.C64_53];
const ALL = new Set(C64S.map(d => d.id));

test('parseMode: display keys, flags and a width', () => {
  assert.deepEqual(parseMode('c64-80'), { keys: ['c64-80'], flags: [], cols: 0 });
  assert.deepEqual(parseMode('ext, game'), { keys: [], flags: ['ext', 'game'], cols: 0 });
  assert.deepEqual(parseMode('80'), { keys: [], flags: [], cols: 80 });
  assert.equal(parseMode('wide'), null);
  assert.equal(parseMode(''), null);
});

test('pickDisplay: the current display if it will do, else the fastest that will', () => {
  const pick = (spec, cur, ids = ALL) => pickDisplay(parseMode(spec), ids, cur)?.key ?? null;
  assert.equal(pick('game', DISPLAY.C64_80), 'c64-80', 'the soft screens have game hardware too');
  assert.equal(pick('ext', DISPLAY.C64_80), 'c64-hires');
  assert.equal(pick('game', DISPLAY.C64_HIRES), 'c64-hires', 'hi-res has game hardware too');
  assert.equal(pick('ext,game', DISPLAY.C64), 'c64-hires');
  assert.equal(pick('50', DISPLAY.C64), 'c64-53');
  assert.equal(pick('80', DISPLAY.C64_53), 'c64-80');
  assert.equal(pick('c64-53,c64-80', DISPLAY.C64), 'c64-53');
  assert.equal(pick('c128', DISPLAY.C64), null);
  assert.equal(pick('80', DISPLAY.C64, new Set([0, 3])), null, 'only what the client has');
});

test('C=+F3 (and C=+SHIFT+F3) step the display', () => {
  const f3 = MATRIX.indexOf('F3');
  assert.deepEqual(keyToBytes(f3, CBM), { mode: 1 });
  assert.deepEqual(keyToBytes(f3, CBM | SHIFT), { mode: -1 });
  assert.equal(keyToBytes(f3, 0), '\t');
});

async function start(extra, script = 'cat') {
  const port = await new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });
  const proc = spawn('node', [BRIDGE, '--port', String(port), '--title', 'none', '--sound', 'off', '--fps', '50', ...extra, '--', 'sh', '-c', script],
    { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, PATH: `${fileURLToPath(new URL('../bin', import.meta.url))}:${process.env.PATH}` } });
  let log = '';
  proc.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 80 && !/control on/.test(log); i++) await sleep(50);
  return { port, log: () => log, stop: () => proc.kill() };
}

// A client on `display` that, if `modes`, can switch to the C64's displays: on MODE it starts again on the new
// one (unless `deaf`), as the combined client does.
function client(port, display, { modes = true, deaf = false } = {}) {
  const c = { display, dec: new Decoder(display.cols, display.rows), switches: [], modeOps: 0 };
  const hello = () => [MSG.HELLO_ON, c.display.id, ...(modes ? [MSG.MODES, 0x80 | [...ALL].reduce((m, id) => m | 1 << id, 0)] : [])];
  c.sock = net.connect(port, '127.0.0.1', () => c.sock.write(Buffer.from(hello())));
  c.sock.on('error', () => {});
  c.sock.on('data', d => {
    c.dec.feed(d);
    for (const b of d) if (b === OP.FRAME) c.sock.write(Buffer.from([MSG.ACK]));
    if (c.dec.mode === undefined) return;
    c.modeOps++;
    if (deaf) { c.dec.mode = undefined; return; }
    c.display = displayById(c.dec.mode);
    c.switches.push(c.display.key);
    c.dec = new Decoder(c.display.cols, c.display.rows);
    c.sock.write(Buffer.from(hello()));
  });
  c.key = (code, mods = 0) => c.sock.write(Buffer.from([MSG.KEY, code, mods]));
  return c;
}

const ctl = (port, line) => new Promise(ok => {
  const s = net.connect(port + 1, '127.0.0.1', () => s.write(line + '\n'));
  s.once('data', d => { ok(String(d).trim()); s.destroy(); });
});

function text(c) {
  let s = '';
  for (const g of c.dec.glyph) s += String.fromCharCode(g === 0 ? 64 : g < 32 ? g + 96 : g);
  return s;
}

// What the program sees: its terminal's size, every half second.
const SIZES = 'while :; do stty size; sleep 0.3; done';

test('--mode puts a client that can switch on that display, and the program gets its size', async () => {
  const b = await start(['--mode', 'c64-80'], SIZES);
  const c = client(b.port, DISPLAY.C64);
  try {
    assert.ok(await waitFor(() => c.display === DISPLAY.C64_80 && text(c).includes('25 80')), text(c));
    assert.deepEqual(c.switches, ['c64-80']);
  } finally { c.sock.destroy(); b.stop(); }
});

test('a client that does not say MODES is never sent MODE', async () => {
  const b = await start(['--mode', 'c64-80'], SIZES);
  const c = client(b.port, DISPLAY.C64, { modes: false });
  try {
    assert.ok(await waitFor(() => text(c).includes('25 40')), text(c));
    await sleep(500);
    assert.equal(c.modeOps, 0);
    assert.equal(await ctl(b.port, 'mode'), "c64 (can't switch)");
    assert.match(await ctl(b.port, 'mode next'), /^error/);
  } finally { c.sock.destroy(); b.stop(); }
});

test('the control port and C=+F3 switch the display', async () => {
  const b = await start([], SIZES);
  const c = client(b.port, DISPLAY.C64);
  try {
    assert.ok(await waitFor(() => text(c).includes('25 40')));
    assert.equal(await ctl(b.port, 'mode'), 'c64 (can switch to: c64, c64-hires, c64-53, c64-80)');
    assert.equal(await ctl(b.port, 'mode 80'), 'c64-80');
    assert.ok(await waitFor(() => c.display === DISPLAY.C64_80 && text(c).includes('25 80')), text(c));
    c.key(MATRIX.indexOf('F3'), CBM); // after c64-80, round to c64
    assert.ok(await waitFor(() => c.display === DISPLAY.C64 && text(c).includes('25 40')), text(c));
    c.key(MATRIX.indexOf('F3'), CBM | SHIFT);
    assert.ok(await waitFor(() => c.display === DISPLAY.C64_80), c.display.key);
    assert.match(await ctl(b.port, 'mode c128'), /^error: the client has no such display/);
    assert.match(await ctl(b.port, 'mode wide'), /^error: unknown mode/);
  } finally { c.sock.destroy(); b.stop(); }
});

test('petty-mode: a program asks for a display, runs on it, and the display goes back after', async () => {
  // 80 columns for one command; then game hardware, which the hi-res screen has (no switch); then the text screen.
  const script = `petty-mode 80 stty size; sleep 1; petty-mode game; sleep 1; petty-mode c64; stty size; sleep 10`;
  const b = await start([], script);
  const c = client(b.port, DISPLAY.C64_HIRES);
  try {
    assert.ok(await waitFor(() => c.switches.length >= 3, 10000), `${c.switches} ${b.log()} ${text(c)}`);
    assert.deepEqual(c.switches, ['c64-80', 'c64-hires', 'c64'], 'to 80 columns, back, and to text');
    assert.ok(await waitFor(() => /c64;40;25;game,sound/.test(text(c)) && text(c).includes('25 40')), text(c));
  } finally { c.sock.destroy(); b.stop(); }
});

test('a client that never answers MODE stays where it was, redrawn, and is not asked again', async () => {
  const b = await start(['--mode', 'c64-80'], SIZES);
  const c = client(b.port, DISPLAY.C64, { deaf: true });
  try {
    assert.ok(await waitFor(() => /no HELLO_ON from C64 soft-80/.test(b.log()), 9000), b.log());
    assert.ok(await waitFor(() => text(c).includes('25 40')), text(c));
    await sleep(600);
    assert.equal(c.modeOps, 1);
  } finally { c.sock.destroy(); b.stop(); }
});
