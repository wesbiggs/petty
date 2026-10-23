// The game hardware commands (sprites, glides, MOVE, SID scripts: protocol.js), on the text and hi-res clients in
// VICE: what they do to the emulated machine, read through VICE's remote monitor, and to the SID, from VICE's dump.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MSG, OP, Decoder, encodeSprDef, encodeSpr, encodeGlide, encodeMove, encodeSidW, encodeSidPlay, encodeSidStop, encodePoke } from '../src/protocol.js';
import { compileScript, SCRIPT_BASE } from '../src/game.js';
import { link, vice, sleep } from './lib/vice.js';

for (const name of ['c64', 'hires']) {
  const hires = name === 'hires';
  // Where the client keeps its shapes and their pointers (and the number of shape 0's).
  const L = hires ? { blocks: 0x4800, ptrs: 0x5FF8, ptr0: 0x20 } : { blocks: 0x2000, ptrs: 0x07F8, ptr0: 0x80 };

  describe(`${name}: game hardware`, () => {
    let l, v;
    // The reference: what the bridge's decoder says the screen should be.
    const ref = new Decoder();
    // Sends bytes plus a FRAME, and waits for the ACK.
    const frame = async bytes => { l.write([...bytes, OP.FRAME]); await l.until(() => l.take(MSG.ACK), 'ACK'); };
    const send = async bytes => { ref.feed([...bytes, OP.FRAME]); await frame(bytes); };

    before(async () => {
      l = await link();
      v = await vice(name, { port: l.port, sound: 'sid.dump' });
      await l.until(() => l.take(hires ? MSG.HELLO_ON : MSG.HELLO), 'hello', 60000);
      if (hires) await l.until(() => l.rx.length, 'the display');
      l.rx.length = 0;
      await sleep(500);
    });
    after(async () => { await v?.stop(); l?.close(); });

    it('sprite shape, position and colour', async () => {
      const shape = Array.from({ length: 63 }, (_, i) => (i * 7 + 1) & 255);
      await send([...encodeSprDef(3, shape), ...encodeSpr(1, 3, 5, 2 | 1, 300, 100)]);
      const { io, ram } = await v.machine();
      assert.deepEqual([...ram.subarray(L.blocks + 3 * 64, L.blocks + 3 * 64 + 63)], shape, 'shape bytes');
      assert.equal(ram[L.ptrs + 1], L.ptr0 + 3, 'pointer');
      assert.equal(io[0x02], 300 - 256, 'x low');
      assert.equal(io[0x10] & 2, 2, 'x bit 8');
      assert.equal(io[0x03], 100, 'y');
      assert.equal(io[0x28] & 15, 5, 'colour');
      assert.equal(io[0x15] & 2, 2, 'enabled');
      assert.equal(io[0x1A] & 1, 0, 'no raster interrupt until a glide or a script needs it');
    });

    it('the last shape slot, 63', async () => {
      const shape = Array.from({ length: 63 }, (_, i) => 255 - i);
      await send([...encodeSprDef(63, shape), ...encodeSpr(7, 63, 2, 2, 20, 30)]);
      const { io, ram } = await v.machine();
      assert.deepEqual([...ram.subarray(L.blocks + 63 * 64, L.blocks + 63 * 64 + 63)], shape);
      assert.equal(ram[L.ptrs + 7], L.ptr0 + 63);
      assert.equal(io[0x15] & 0x80, 0x80);
    });

    it('flags: wide, tall, behind, multicolour; hide', async () => {
      await send(encodeSpr(2, 0, 1, 2 | 4 | 8 | 16 | 32, 50, 60));
      let { io } = await v.machine();
      for (const reg of [0x1C, 0x1D, 0x17, 0x1B]) assert.equal(io[reg] & 4, 4, `register ${reg.toString(16)}`);
      await send(encodeSpr(2, 0, 1, 0, 50, 60));
      ({ io } = await v.machine());
      assert.equal(io[0x15] & 4, 0, 'disabled');
      for (const reg of [0x1C, 0x1D, 0x17, 0x1B]) assert.equal(io[reg] & 4, 0, `register ${reg.toString(16)} cleared`);
      assert.equal(io[0x15] & 2, 2, 'sprite 1 unaffected');
    });

    it('glide: right across x = 256, with the done message', async () => {
      await send(encodeSpr(1, 3, 5, 2, 240, 100));
      await frame(encodeGlide(1, 10, 3, -2));
      await l.until(() => l.take(MSG.GLIDE), 'glide done message', 3000);
      const { io } = await v.machine();
      assert.equal(io[0x02] | (io[0x10] >> 1 & 1) << 8, 270, 'x');
      assert.equal(io[0x03], 80, 'y');
    });

    it('glide: left across x = 256', async () => {
      await send(encodeSpr(1, 3, 5, 2 | 1, 258, 100));
      await frame(encodeGlide(1, 4, -3, 1));
      await l.until(() => l.take(MSG.GLIDE), 'glide done message', 3000);
      const { io } = await v.machine();
      assert.equal(io[0x10] & 2, 0, 'bit 8 cleared');
      assert.equal(io[0x02], 246, 'x');
      assert.equal(io[0x03], 104, 'y');
    });

    it('glides: two at once, one done message after both', async () => {
      await send([...encodeSpr(1, 3, 5, 2, 100, 100), ...encodeSpr(4, 3, 5, 2, 100, 150)]);
      await frame([...encodeGlide(1, 3, 1, 0), ...encodeGlide(4, 12, 0, -1)]);
      await l.until(() => l.take(MSG.GLIDE), 'glide done message', 3000);
      const { io } = await v.machine();
      assert.equal(io[0x02], 103);
      assert.equal(io[0x09], 150 - 12, 'the slower one had finished too');
      assert.ok(!l.rx.includes(MSG.GLIDE), 'only one message');
    });

    it('MOVE: random rectangles and shifts, as the decoder does them', async () => {
      // A screen of distinct codes and colours first.
      const fill = [];
      for (let y = 0; y < 25; y++) {
        fill.push(OP.GOTO, y, 0);
        for (let x = 0; x < 40; x++) fill.push(OP.COLOR, hires ? (x * 16 + y * 5 + 1) & 255 : (x + y) & 15, OP.PUT, 1, 33 + (x * 3 + y * 7) % 90);
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
      const { io, ram } = await v.machine();
      for (let i = 0; i < 1000; i++) {
        if (hires) { // a cell is its glyph's 8 font bytes in the bitmap, and a colour byte
          for (let r = 0; r < 8; r++) assert.equal(ram[0x6000 + i * 8 + r], ram[0x4000 + r * 256 + ref.glyph[i]], `bitmap row ${r} of cell ${i}`);
          assert.equal(ram[0x5C00 + i], ref.color[i], `colour at ${i}`);
        } else {
          assert.equal(ram[0x400 + i], ref.glyph[i], `screen code at ${i}`);
          assert.equal(io[0x800 + i] & 15, ref.color[i], `colour at ${i}`);
        }
      }
    });

    it('MOVE: a rectangle off the screen does nothing', async () => {
      const area = ram => hires ? ram.subarray(0x6000, 0x6000 + 8000) : ram.subarray(0x400, 0x400 + 1000);
      const before = area((await v.machine()).ram).slice();
      await frame(encodeMove(30, 0, 10, 5, 5, 0)); // not sent to the reference: it does nothing
      await frame(encodeMove(0, 20, 5, 6, 0, 0));
      assert.deepEqual([...area((await v.machine()).ram)], [...before]);
    });

    // Last: VICE writes the SID dump as it quits.
    it('SID: a script plays, loops, and is masked', async () => {
      // Music on voice 1: set frequency, gate on; after 3 frames change the frequency; loop.
      // It also tries to write voice 3's frequency (masked out for this channel).
      const script = [3, 0, 0x11, 1, 0x25, 14, 0x99, 3, 2, 4, 0x11, 1, 0x28, 3, 2, 0, 0x20, 14, 0x77, 2, 254];
      const { bytes } = compileScript(script, SCRIPT_BASE);
      // An effect on channel 1, voice 3 only, which also reaches for voice 1's frequency.
      const fx = compileScript([2, 14, 0x31, 0, 0xEE, 1, 0xFF], SCRIPT_BASE + 0x100).bytes;
      await send([...encodePoke(SCRIPT_BASE, bytes), ...encodePoke(SCRIPT_BASE + 0x100, fx), ...encodeSidW([24, 15]),
        ...encodeSidPlay(0, SCRIPT_BASE, 0x7F), ...encodeSidPlay(1, SCRIPT_BASE + 0x100, 0x7F << 14)]);
      await sleep(2000);
      const { ram } = await v.machine();
      assert.deepEqual([...ram.subarray(SCRIPT_BASE, SCRIPT_BASE + bytes.length)], [...bytes], 'script in memory');
      assert.equal(ram[0xC018], 1, 'channel 0 is playing');
      await send(encodeSidStop(255));
      await sleep(300);
      await v.quit();
      const dump = readFileSync(join(v.work, 'sid.dump'), 'utf8').split('\n');
      assert.ok(dump.length > 10, 'sound dump has content');
      const writes = dump.map(s => s.trim().split(/\s+/).map(Number)).filter(w => w.length >= 3 && w.every(Number.isFinite));
      const regs = writes.map(w => [w[w.length - 2], w[w.length - 1]]);
      assert.ok(regs.some(([r, x]) => r === 14 && x === 0x31), 'the effect on voice 3');
      assert.ok(!regs.some(([r, x]) => r === 0 && x === 0xEE), "the effect's write to voice 1 is masked");
      // Frames: the 0x25 write and the 0x28 write are 3 frames apart (a PAL frame is 19656 cycles).
      let t = 0, at25 = null;
      for (const w of writes) {
        t += w[0];
        const [r, x] = [w[1], w[2]];
        if (r === 1 && x === 0x25) at25 = t;
        else if (r === 1 && x === 0x28 && at25 !== null) {
          const frames = (t - at25) / 19656;
          assert.ok(frames > 2.7 && frames < 3.3, `3 frames between records, not ${frames.toFixed(2)}`);
          break;
        }
      }
      assert.ok(regs.some(([r, x]) => r === 0 && x === 0x11), 'frequency low');
      assert.ok(regs.some(([r, x]) => r === 1 && x === 0x28), 'frequency high, 3 frames later');
      assert.ok(!regs.some(([r, x]) => r === 14 && (x === 0x99 || x === 0x77)), 'voice 3 is masked out');
      const f = regs.filter(([r]) => r === 1).length;
      assert.ok(f >= 4, `the script looped (${f} frequency writes)`);
      assert.ok(regs.some(([r, x], i) => r === 4 && x === 0 && i > 0), 'gate down on stop');
    });
  });
}
