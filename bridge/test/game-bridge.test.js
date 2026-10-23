// The whole way: a program in the bridge's pty prints OSC 8348 / 8349, and a fake C64
// gets sprites and SID commands, in the frame with the screen's own changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Decoder, MSG, OP, DISPLAY, VIEW } from '../src/protocol.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  assert.deepEqual([...dec.glyph.subarray(0, 5)], [8, 5, 12, 12, 15], '"hello" in screen codes');
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

test('the soft 80-column client gets them too', async () => {
  const script = `printf '${osc(8348, 'def', 1, b64(new Uint8Array(63)))}${osc(8348, 'set', 2, 1, 10, 20, 3)}ok'; sleep 5`;
  const { dec } = await run(script, { display: DISPLAY.C64_80, wait: 8000, until: d => d.hw[2] });
  assert.equal(dec.hw[2].x, 34);
});

test('a client without game hardware (the C128) gets none of it', async () => {
  const script = `printf '${osc(8348, 'def', 0, b64(new Uint8Array(63)))}${osc(8348, 'set', 0, 0, 10, 10, 1)}${osc(8349, 'w', 24, 15)}ok'; sleep 3`;
  const { dec } = await run(script, { display: DISPLAY.C128, wait: 8000, until: d => d.glyph.some(g => g !== 32) });
  assert.equal(dec.shapes.size, 0);
  assert.equal(dec.hw.filter(Boolean).length, 0);
  assert.equal(dec.sid.length, 0);
  assert.ok(dec.glyph.some(g => g !== 32), 'the text still shows');
});

// OSC 8350: a program asks what it is drawing on.
for (const [display, want] of [
  [DISPLAY.C64, 'c64;40;25;game,sound,picture'],
  [DISPLAY.C64_HIRES, 'c64-hires;40;25;hires,ext,game,sound,picture,images'],
  [DISPLAY.C64_80, 'c64-80;80;25;game,sound,pair,picture,images'],
  [DISPLAY.C64_53, 'c64-53;53;25;game,sound,quad,picture,images'],
  [DISPLAY.C128, 'c128;80;25;ext,sound,reverse'],
]) {
  test(`OSC 8350 display: the program is told it is on the ${display.name}`, async () => {
    // The program asks as it starts, usually before the client's HELLO has been read: the answer is
    // whatever the client turns out to be, not a guess. It writes what it was told to the screen.
    const asker = fileURLToPath(new URL('../scripts/ask-display.js', import.meta.url));
    const { dec } = await run(`node ${asker}`, { display, wait: 8000, until: d => /8350;display;/.test(screenText(d, display)) });
    const text = screenText(dec, display), at = text.indexOf(`8350;display;${want}`);
    assert.ok(at >= 0 && !/[a-z,]/.test(text[at + 13 + want.length]), text); // all of it, not a prefix
  });
}

function screenText(dec, display) {
  let s = '';
  for (let i = 0; i < display.cols * display.rows; i++) s += String.fromCharCode(dec.glyph[i] === 0 ? 64 : dec.glyph[i] < 32 ? dec.glyph[i] + 96 : dec.glyph[i]);
  return s;
}

// petty-view: a picture full screen, on any C64 client; in the terminal on the C128.
const doodleFile = () => {
  const buf = Buffer.alloc(9218);
  for (let i = 2; i < buf.length; i++) buf[i] = (i * 29) & 0xff;
  const file = join(mkdtempSync(join(tmpdir(), 'petty-view-')), 'pic.dd');
  writeFileSync(file, buf);
  return { file, buf };
};

test('petty-view shows a hi-res picture full screen on the soft 80-column client', async () => {
  const { file, buf } = doodleFile();
  const { dec } = await run(`petty-view ${file}; sleep 5`, { display: DISPLAY.C64_80, wait: 10000, until: d => d.view === VIEW.SHOW });
  assert.equal(dec.view, VIEW.SHOW);
  assert.ok(Buffer.from(dec.mem.subarray(0x6000, 0x6000 + 8000)).equals(buf.subarray(1026, 9026)), 'the bitmap');
  assert.ok(Buffer.from(dec.mem.subarray(0x5C00, 0x5C00 + 1000)).equals(buf.subarray(2, 1002)), 'its colours');
});

test('petty-view on the C128 shows the picture in the terminal instead', async () => {
  const { file } = doodleFile();
  const { dec } = await run(`petty-view ${file}; sleep 5`, { display: DISPLAY.C128, wait: 8000, until: d => d.glyph.some(g => g !== 32) });
  assert.equal(dec.view, VIEW.TERMINAL);
  assert.ok(dec.glyph.some(g => g !== 32), 'drawn in the terminal');
});
