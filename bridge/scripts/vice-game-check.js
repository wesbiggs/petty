// Runs the C64 text client (build/petty.prg) in VICE and checks what the game
// hardware commands (sprites, glides, MOVE, SID scripts: protocol.js) do to the
// emulated machine, through VICE's remote monitor. This script is the bridge:
// VICE's SwiftLink dials it. Needs x64sc; opens a VICE window.
//
// usage: node scripts/vice-game-check.js [--keep] [prg]
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { MSG, OP, Decoder, encodeSprDef, encodeSpr, encodeGlide, encodeMove, encodeSidW, encodeSidPlay, encodeSidStop, encodePoke, DISPLAY } from '../src/protocol.js';
import { compileScript, SCRIPT_BASE } from '../src/game.js';

const { values: opt, positionals } = parseArgs({ allowPositionals: true, options: { keep: { type: 'boolean', default: false } } });
const prg = resolve(positionals[0] ?? fileURLToPath(new URL('../../build/petty.prg', import.meta.url)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.error('[vice-check]', ...a);
const freePort = () => new Promise((ok, fail) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }).on('error', fail); });

const work = mkdtempSync(join(tmpdir(), 'petty-game-'));
copyFileSync(prg, join(work, 'petty.prg'));
const linkPort = await freePort(), monPort = await freePort();

// --- the link: we are the bridge ---------------------------------------------

let sock = null, rx = [];
const waiters = [];
const link = net.createServer(s => {
  sock = s;
  s.on('data', d => { rx.push(...d); for (const w of [...waiters]) w(); });
}).listen(linkPort, '127.0.0.1');
const waitFor = async (pred, what, ms = 15000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const r = pred();
    if (r) return r;
    await new Promise(res => { waiters.push(res); setTimeout(res, 50); });
    waiters.length = 0;
  }
  throw new Error(`timed out waiting for ${what}`);
};
// Takes one message of the type from what the C64 sent (they are one byte here).
const take = type => { const i = rx.indexOf(type); if (i < 0) return false; rx.splice(i, 1); return true; };

// --- VICE ---------------------------------------------------------------------

const dumpFile = join(work, 'sid.dump');
const vice = spawn('x64sc', [
  '-autostartprgmode', '1', '-autostart', 'petty.prg',
  '-acia1', '-acia1mode', '1', '-acia1base', '0xDE00', '-acia1irq', '1', '-myaciadev', '0',
  '-rsdev1', `127.0.0.1:${linkPort}`, '+rsdev1ip232', '-rsdev1baud', '38400',
  '-sound', '-sounddev', 'dump', '-soundarg', dumpFile,
  '-remotemonitor', '-remotemonitoraddress', `ip4://127.0.0.1:${monPort}`,
], { cwd: work, stdio: 'ignore' });
vice.on('error', e => { log(`can't run x64sc: ${e.message}`); process.exit(2); });

async function monitor(cmds) {
  const s = net.connect(monPort, '127.0.0.1');
  await new Promise((ok, fail) => s.once('connect', ok).once('error', fail));
  let text = '';
  s.on('data', d => { text += d; });
  const prompt = async () => {
    for (let t = 0; t < 100 && !/\(C:\$[0-9a-f]{4}\) $/i.test(text); t++) await sleep(50);
    const out = text; text = ''; return out;
  };
  for (const cmd of [...cmds, 'x']) { await prompt(); s.write(cmd + '\n'); }
  await sleep(100);
  s.destroy();
}
// All of RAM, and the I/O area (VIC, SID, colour RAM).
async function machine() {
  await monitor(['bank io', 'bsave "io.bin" 0 d000 dfff', 'bank ram', 'bsave "ram.bin" 0 0000 ffff']);
  const io = readFileSync(join(work, 'io.bin')), ram = readFileSync(join(work, 'ram.bin'));
  // bsave of a file that exists is refused: VICE overwrote nothing, so remove them
  rmSync(join(work, 'io.bin')); rmSync(join(work, 'ram.bin'));
  return { io, ram };
}

// Sends bytes plus a FRAME, and waits for the ACK.
async function frame(bytes) {
  sock.write(Buffer.from([...bytes, OP.FRAME]));
  await waitFor(() => take(MSG.ACK), 'ACK');
}

const results = [];
async function check(name, fn) {
  try { await fn(); results.push([name, true]); log(`ok   ${name}`); }
  catch (e) { results.push([name, false]); log(`FAIL ${name}: ${e.message}`); }
}

try {
  await waitFor(() => take(MSG.HELLO), 'HELLO from the client', 60000);
  log('client is up');
  await sleep(500);

  // The reference: what the bridge's decoder says the screen should be.
  const ref = new Decoder();
  const send = async bytes => { ref.feed([...bytes, OP.FRAME]); await frame(bytes); };

  await check('sprite shape, position and colour', async () => {
    const shape = Array.from({ length: 63 }, (_, i) => (i * 7 + 1) & 255);
    await send([...encodeSprDef(3, shape), ...encodeSpr(1, 3, 5, 2 | 1, 300, 100)]);
    const { io, ram } = await machine();
    assert.deepEqual([...ram.subarray(0x2000 + 3 * 64, 0x2000 + 3 * 64 + 63)], shape, 'shape bytes');
    assert.equal(ram[0x07F9], 0x80 + 3, 'pointer');
    assert.equal(io[0x02], 300 - 256, 'x low');
    assert.equal(io[0x10] & 2, 2, 'x bit 8');
    assert.equal(io[0x03], 100, 'y');
    assert.equal(io[0x28] & 15, 5, 'colour');
    assert.equal(io[0x15] & 2, 2, 'enabled');
  });

  await check('flags: wide, tall, behind, multicolour; hide', async () => {
    await send(encodeSpr(2, 0, 1, 2 | 4 | 8 | 16 | 32, 50, 60));
    let { io } = await machine();
    for (const reg of [0x1C, 0x1D, 0x17, 0x1B]) assert.equal(io[reg] & 4, 4, `register ${reg.toString(16)}`);
    await send(encodeSpr(2, 0, 1, 0, 50, 60));
    ({ io } = await machine());
    assert.equal(io[0x15] & 4, 0, 'disabled');
    for (const reg of [0x1C, 0x1D, 0x17, 0x1B]) assert.equal(io[reg] & 4, 0, `register ${reg.toString(16)} cleared`);
    assert.equal(io[0x15] & 2, 2, 'sprite 1 unaffected');
  });

  await check('glide: right across x = 256, with the done message', async () => {
    await send(encodeSpr(1, 3, 5, 2, 240, 100));
    sock.write(Buffer.from([...encodeGlide(1, 10, 3, -2), OP.FRAME]));
    await waitFor(() => take(MSG.ACK), 'ACK');
    await waitFor(() => take(MSG.GLIDE), 'glide done message', 3000);
    const { io } = await machine();
    const x = io[0x02] | (io[0x10] >> 1 & 1) << 8;
    assert.equal(x, 270, 'x');
    assert.equal(io[0x03], 80, 'y');
  });

  await check('glide: left across x = 256', async () => {
    await send(encodeSpr(1, 3, 5, 2 | 1, 258, 100));
    sock.write(Buffer.from([...encodeGlide(1, 4, -3, 1), OP.FRAME]));
    await waitFor(() => take(MSG.ACK), 'ACK');
    await waitFor(() => take(MSG.GLIDE), 'glide done message', 3000);
    const { io } = await machine();
    assert.equal(io[0x10] & 2, 0, 'bit 8 cleared');
    assert.equal(io[0x02], 246, 'x');
    assert.equal(io[0x03], 104, 'y');
  });

  await check('glides: two at once, one done message after both', async () => {
    await send([...encodeSpr(1, 3, 5, 2, 100, 100), ...encodeSpr(4, 3, 5, 2, 100, 150)]);
    sock.write(Buffer.from([...encodeGlide(1, 3, 1, 0), ...encodeGlide(4, 12, 0, -1), OP.FRAME]));
    await waitFor(() => take(MSG.ACK), 'ACK');
    await waitFor(() => take(MSG.GLIDE), 'glide done message', 3000);
    const { io } = await machine();
    assert.equal(io[0x02], 103);
    assert.equal(io[0x09], 150 - 12, 'the slower one had finished too');
    assert.ok(!rx.includes(MSG.GLIDE), 'only one message');
  });

  await check('MOVE: random rectangles and shifts, as the decoder does them', async () => {
    // A screen of distinct codes and colours first.
    const fill = [OP.GOTO, 0, 0];
    for (let y = 0; y < 25; y++) {
      fill.push(OP.GOTO, y, 0);
      for (let x = 0; x < 40; x++) fill.push(OP.COLOR, (x + y) & 15, OP.PUT, 1, 33 + (x * 3 + y * 7) % 90);
    }
    await send(fill);
    let seed = 7;
    const rnd = n => (seed = (seed * 1103515245 + 12345) & 0x7fffffff, (seed >> 8) % n);
    for (let k = 0; k < 40; k++) {
      const w = 1 + rnd(30), h = 1 + rnd(20), x = rnd(41 - w), y = rnd(26 - h);
      const dx = rnd(2 * Math.min(8, 40 - w) + 1) - Math.min(8, 40 - w), dy = rnd(2 * Math.min(6, 25 - h) + 1) - Math.min(6, 25 - h);
      if (x + dx < 0 || x + dx + w > 40 || y + dy < 0 || y + dy + h > 25) { k--; continue; }
      await send(encodeMove(x, y, w, h, dx, dy));
    }
    const { io, ram } = await machine();
    for (let i = 0; i < 1000; i++) {
      assert.equal(ram[0x400 + i], ref.glyph[i], `screen code at ${i}`);
      assert.equal(io[0x800 + i] & 15, ref.color[i], `colour at ${i}`);
    }
  });

  await check('MOVE: a rectangle off the screen does nothing', async () => {
    const before = (await machine()).ram.subarray(0x400, 0x400 + 1000).slice();
    await frame(encodeMove(30, 0, 10, 5, 5, 0)); // not sent to the reference: it does nothing
    await frame(encodeMove(0, 20, 5, 6, 0, 0));
    const { ram } = await machine();
    assert.deepEqual([...ram.subarray(0x400, 0x400 + 1000)], [...before]);
  });

  await check('SID: a script plays, loops, and is masked', async () => {
    // Music on voice 1: set frequency, gate on; after 3 frames change the frequency; loop.
    // It also tries to write voice 3's frequency (masked out for this channel).
    const script = [3, 0, 0x11, 1, 0x25, 14, 0x99, 3, 2, 4, 0x11, 1, 0x28, 3, 2, 0, 0x20, 14, 0x77, 2, 254];
    const { bytes } = compileScript(script, SCRIPT_BASE);
    // An effect on channel 1, voice 3 only, which also reaches for voice 1's frequency.
    const fx = compileScript([2, 14, 0x31, 0, 0xEE, 1, 0xFF], SCRIPT_BASE + 0x100).bytes;
    await send([...encodePoke(SCRIPT_BASE, bytes), ...encodePoke(SCRIPT_BASE + 0x100, fx), ...encodeSidW([24, 15]),
      ...encodeSidPlay(0, SCRIPT_BASE, 0x7F), ...encodeSidPlay(1, SCRIPT_BASE + 0x100, 0x7F << 14)]);
    await sleep(2000);
    {
      const { ram } = await machine();
      assert.deepEqual([...ram.subarray(SCRIPT_BASE, SCRIPT_BASE + bytes.length)], [...bytes], 'script in memory');
      assert.equal(ram[0xC018], 1, 'channel 0 is playing');
      log(`channel 0 at $${(ram[0xC020 | 0] | ram[0xC024] << 8).toString(16)}, wait ${ram[0xC01C]}`);
    }
    await send(encodeSidStop(255));
    await sleep(300);
    // The dump is written as VICE exits.
    const exited = new Promise(r => vice.once('exit', r));
    const m = net.connect(monPort, '127.0.0.1');
    await new Promise(r => m.once('connect', r));
    await sleep(300);
    m.write('quit\n');
    await exited;
    const dump = readFileSync(dumpFile, 'utf8').split('\n');
    assert.ok(dump.length > 10, 'sound dump has content');
    const writes = dump.map(l => l.trim().split(/\s+/).map(Number)).filter(w => w.length >= 3 && w.every(Number.isFinite));
    log(`${writes.length} SID writes in the dump`);
    const regs = writes.map(w => [w[w.length - 2], w[w.length - 1]]);
    assert.ok(regs.some(([r, v]) => r === 14 && v === 0x31), 'the effect on voice 3');
    assert.ok(!regs.some(([r, v]) => r === 0 && v === 0xEE), "the effect's write to voice 1 is masked");
    // Frames: the 0x25 write and the 0x28 write are 3 frames apart (a PAL frame is 19656 cycles).
    let t = 0, at25 = null;
    for (const w of writes) {
      t += w[0];
      const [r, v] = [w[1], w[2]];
      if (r === 1 && v === 0x25) at25 = t;
      else if (r === 1 && v === 0x28 && at25 !== null) {
        const frames = (t - at25) / 19656;
        assert.ok(frames > 2.7 && frames < 3.3, `3 frames between records, not ${frames.toFixed(2)}`);
        break;
      }
    }
    assert.ok(regs.some(([r, v]) => r === 0 && v === 0x11), 'frequency low');
    assert.ok(regs.some(([r, v]) => r === 1 && v === 0x28), 'frequency high, 3 frames later');
    assert.ok(!regs.some(([r, v]) => r === 14 && (v === 0x99 || v === 0x77)), 'voice 3 is masked out');
    const f = regs.filter(([r]) => r === 1).length;
    assert.ok(f >= 4, `the script looped (${f} frequency writes)`);
    assert.ok(regs.some(([r, v], i) => r === 4 && v === 0 && i > 0), 'gate down on stop');
  });
} catch (e) {
  results.push(['setup', false]);
  log(`FAIL ${e.message}`);
} finally {
  if (!opt.keep) { vice.kill(); link.close(); rmSync(work, { recursive: true, force: true }); } else log(`kept ${work}`);
}
const failed = results.filter(([, ok]) => !ok).length;
log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
