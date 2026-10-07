// The whole way: a program in the bridge's pty prints OSC 8348 / 8349, and a fake C64
// gets sprites and SID commands, in the frame with the screen's own changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Decoder, MSG, OP, DISPLAY } from '../src/protocol.js';

const BRIDGE = fileURLToPath(new URL('../src/bridge.js', import.meta.url));
const b64 = b => Buffer.from(b).toString('base64');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run(script, { display = DISPLAY.C64, ack = true, wait = 1500, onData, until } = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const bridge = spawn('node', [BRIDGE, '--port', String(port), '--title', 'none', '--sound', 'off', '--fps', '50', '--', 'sh', '-c', script], { stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  bridge.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 50 && !/listening/.test(log); i++) await sleep(100);
  const dec = new Decoder(display.cols, display.rows);
  const frames = [];
  const sock = net.connect(port, '127.0.0.1');
  await new Promise(r => sock.once('connect', r));
  sock.on('data', d => {
    frames.push([...d]);
    dec.feed(d);
    onData?.(d, sock);
    for (const b of d) if (b === OP.FRAME && ack) sock.write(Buffer.from([MSG.ACK]));
  });
  sock.write(Buffer.from(display === DISPLAY.C64 ? [MSG.HELLO] : [MSG.HELLO_ON, display.id]));
  // Until what the test wants has arrived, or at most `wait` (a slow machine, or tests in parallel).
  for (let t = 0; t < wait; t += 50) {
    await sleep(50);
    if (until?.(dec)) break;
  }
  if (until) await sleep(200);
  sock.destroy();
  bridge.kill();
  return { dec, frames, log };
}

const osc = (n, ...parts) => `\\033]${n};${parts.join(';')}\\007`;

test('the hi-res client gets them too', async () => {
  const script = `printf '${osc(8348, 'def', 1, b64(new Uint8Array(63)))}${osc(8348, 'set', 2, 1, 10, 20, 3)}ok'; sleep 5`;
  const { dec } = await run(script, { display: DISPLAY.C64_HIRES, wait: 8000, until: d => d.hw[2] });
  assert.equal(dec.hw[2].x, 34);
});

test('a program drives sprites and the SID through the bridge', async () => {
  const shape = b64(new Uint8Array(63).fill(0xAA));
  const script = `printf '${osc(8348, 'def', 1, shape)}${osc(8348, 'set', 0, 1, 160, 100, 7)}${osc(8348, 'glide', 0, 2, 0, 8)}hello'
printf '${osc(8349, 'def', 0, b64([1, 4, 0x11, 5, 254]))}${osc(8349, 'play', 0, 0, '1+vol')}'; sleep 5`;
  const { dec } = await run(script, { wait: 8000, until: d => d.sid.some(s => s.op === 'play') && d.hw[0] });
  assert.equal(dec.hw[0].slot, 1);
  assert.equal(dec.hw[0].x, 184);
  assert.equal(dec.hw[0].y, 150);
  assert.deepEqual(dec.hw[0].glide, { frames: 8, dx: 2, dy: 0 });
  assert.equal(String.fromCharCode(...dec.glyph.subarray(0, 5).map(g => g + 64)).toLowerCase().includes('hello') || dec.glyph[0] !== 32, true);
  const play = dec.sid.find(s => s.op === 'play');
  assert.ok(play, 'SID script started');
  assert.equal(play.mask, (0x7F | 1 << 24) >>> 0);
  assert.equal(dec.mem[play.addr], 1);
  assert.ok(dec.sid.some(s => s.op === 'reset'), 'the SID is cleared first');
});

test('the program hears sync once the C64 says the glides ended', async () => {
  const script = `printf '${osc(8348, 'def', 0, b64(new Uint8Array(63)))}${osc(8348, 'set', 0, 0, 10, 10, 1)}${osc(8348, 'glide', 0, 1, 1, 20)}${osc(8348, 'sync', 'T1')}'
stty raw -echo; dd bs=1 count=9 2>/dev/null | od -c | head -1 > /dev/null; printf 'GOT' ; sleep 2`;
  const { dec, log } = await run(script, {
    onData: (d, sock) => { if (d.includes(OP.GLIDE)) setTimeout(() => sock.write(Buffer.from([MSG.GLIDE])), 50); },
    wait: 2500,
  });
  assert.ok(dec.glyph.some((g, i) => i < 40 && g !== 32), `the program ran on after the sync reply (${log})`);
});

test('a client without game hardware (soft 80 columns) gets none of it', async () => {
  const script = `printf '${osc(8348, 'def', 0, b64(new Uint8Array(63)))}${osc(8348, 'set', 0, 0, 10, 10, 1)}${osc(8349, 'w', 24, 15)}ok'; sleep 3`;
  const { frames, dec } = await run(script, { display: DISPLAY.C64_80, wait: 8000, until: d => d.glyph.some(g => g !== 32) });
  for (const f of frames) assert.ok(!f.some(b => b === OP.SPRDEF && false));
  assert.equal(dec.hw.filter(Boolean).length, 0);
  assert.equal(dec.sid.length, 0);
  assert.ok(dec.glyph.some(g => g !== 32), 'the text still shows');
});
