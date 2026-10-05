import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decoder, MSG, OP, SOUND_ADDR, SOUND_WINDOW, encodePoke, encodeSound } from '../src/protocol.js';
import { SoundManager } from '../src/sound/manager.js';
import { classifyRegion } from '../src/sound/probe.js';
import { codec, playOnC64, previewOf } from '../src/sound/session.js';
import { decodeLevels, outTable } from '../src/sound/codec.js';
import { LUTS } from '../src/sound/dsp.js';
import { lineTimer } from '../src/sound/timing.js';

const b64 = s => Buffer.from(s).toString('base64');

function manager(extra = {}) {
  const logs = [];
  const m = new SoundManager({ log: s => logs.push(s), enabled: true, lut: 'sid6581', weight: [], getConn: () => null, redraw() {}, ...extra });
  m.pump = () => {}; // the queue is what is being tested, not playing it
  return { m, logs };
}

test('OSC 8347: say, with a voice, play, data, stop', () => {
  const { m, logs } = manager();
  assert.equal(m.osc(`say;${b64('Hello there')};voice=Fred`), true);
  assert.deepEqual(m.queue, [{ text: 'Hello there', voice: 'Fred' }]);
  m.osc(`say;${b64('   ')}`); // nothing to say
  assert.equal(m.queue.length, 1);
  m.osc(`play;${b64('/etc/hosts')}`);
  assert.deepEqual(m.queue[1], { path: '/etc/hosts' });
  m.osc(`play;${b64('/dev/null')}`); // not a regular file
  m.osc(`play;${b64('/nonexistent/x.mp3')}`);
  assert.equal(m.queue.length, 2);
  assert.ok(logs.some(l => /cannot play "\/dev\/null"/.test(l)));
  m.osc(`data;${Buffer.from([1, 2, 3]).toString('base64')}`);
  assert.deepEqual([...m.queue[2].data], [1, 2, 3]);
  m.osc('stop');
  assert.equal(m.queue.length, 0);
  m.osc('wibble;x');
  assert.ok(logs.some(l => /unknown OSC 8347 command wibble/.test(l)));
});

test('with sound off the OSC is swallowed and nothing is queued', () => {
  const { m } = manager({ enabled: false });
  assert.equal(m.osc(`say;${b64('x')}`), true);
  assert.equal(m.queue.length, 0);
});

test('lineTimer: a sample every two raster lines', () => {
  assert.equal(lineTimer(2, 63, 985248).latch, 125);
  assert.ok(Math.abs(lineTimer(2, 63, 985248).rate - 7819.4) < 0.1);
  assert.equal(lineTimer(2, 65, 1022727).latch, 129);
  assert.equal(classifyRegion(17101).lineCycles, 65);
});

test('SOUND and the tables are PETTY commands the reference decoder reads', () => {
  const d = new Decoder();
  d.feed(Uint8Array.from([...encodePoke(SOUND_ADDR.NIDX, [4, 8, 12]), ...encodeSound(1, 6, 129, 100000), OP.PROBE]));
  assert.deepEqual([...d.mem.subarray(SOUND_ADDR.NIDX, SOUND_ADDR.NIDX + 3)], [4, 8, 12]);
  assert.deepEqual(d.sounds, [{ variant: 1, delay: 6, latch: 129, n: 100000 }]);
  assert.throws(() => encodeSound(0, 0, 125, 0), /1 to/);
});

// A C64 that takes codes at 2 KB/s's worth of credits as fast as it is asked to, and holds 256 bytes.
function fakeC64() {
  const conn = { writes: [], sound: { credits: 0, onCredit: null, end: null }, frames: [] };
  const st = { n: 0, got: 0, maxOutstanding: 0, op: null, data: [] };
  conn.sendAndWait = async bytes => { conn.frames.push(bytes); };
  conn.sock = {
    write(buf) {
      if (st.op === null) {
        assert.equal(buf[0], OP.SOUND);
        st.op = [...buf];
        st.n = buf[5] | buf[6] << 8 | buf[7] << 16;
        return;
      }
      for (const byte of buf) st.data.push(byte);
      st.got += buf.length;
      st.maxOutstanding = Math.max(st.maxOutstanding, st.got - conn.sound.credits);
      assert.ok(st.got - conn.sound.credits <= 256, 'the C64\'s buffer overflowed');
      // the C64 plays: one credit a byte, later
      setImmediate(() => {
        for (let i = 0; i < buf.length; i++) {
          conn.sound.credits++;
          conn.sound.onCredit?.();
        }
        if (st.got >= st.n && conn.sound.credits >= st.n) conn.sound.end?.('done');
      });
    },
  };
  return { conn, st };
}

test('playOnC64: tables first, then SOUND, then exactly n bytes within the window, then done', async () => {
  const { conn, st } = fakeC64();
  const target = Float32Array.from({ length: 4 * 700 }, (_, i) => 0.6 * Math.sin(i * 0.05));
  const lut = LUTS.sid6581;
  const { how, codes } = await playOnC64(conn, target, { variant: 0, delay: 4, latch: 125, lut, weight: [-0.6] });
  assert.equal(how, 'done');
  assert.equal(conn.frames.length, 1);
  assert.equal(conn.frames[0].at(-1), OP.FRAME);
  assert.deepEqual(st.op, encodeSound(0, 4, 125, 700));
  assert.equal(st.data.length, 700);
  assert.ok(st.maxOutstanding <= SOUND_WINDOW + 4, `outstanding ${st.maxOutstanding}`);
  assert.equal(codes.length, 2800);
  // the bytes sent are the codes, packed four to a byte, first code in the high bits
  assert.equal(st.data[0], codes[0] << 6 | codes[1] << 4 | codes[2] << 2 | codes[3]);
  // and what they decode to follows the signal
  const y = previewOf(codes, lut);
  assert.equal(y.length, 2801);
  const e = target.reduce((a, v, i) => a + (decodeLevels(codec, codes, lut)[i] - v) ** 2, 0) / target.length;
  assert.ok(e < 0.05, `error ${e}`);
});

test('playOnC64 stops sending when the C64 reports ABORT', async () => {
  const { conn, st } = fakeC64();
  let credits = 0;
  const write = conn.sock.write;
  conn.sock.write = buf => {
    write(buf);
    if (st.op && (credits += buf.length) > 600) setImmediate(() => conn.sound.end?.('abort')); // after about 600 bytes
  };
  const target = Float32Array.from({ length: 4 * 20000 }, (_, i) => 0.5 * Math.sin(i * 0.03));
  const { how } = await playOnC64(conn, target, { variant: 0, delay: 4, latch: 125, lut: LUTS.sid6581, weight: [] });
  assert.equal(how, 'abort');
  assert.ok(st.data.length < 20000, `sent ${st.data.length}`);
});
