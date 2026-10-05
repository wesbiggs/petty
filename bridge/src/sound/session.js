// Plays a signal on the C64 over a connection: encodes it block by block with
// the 2-bit code and streams the codes as the C64 takes them. The screen stays on
// and still while it plays (modal): the bridge sends no frames, and the C64 draws
// nothing, so what the program prints meanwhile waits and is drawn after.
//
// `conn` is the bridge's Connection: sock, sendAndWait(bytes) (a frame, resolved
// on ACK), and the `sound` slot where its parser delivers CREDIT, DONE and ABORT.

import { OP, SOUND_ADDR, SOUND_WINDOW, encodePoke, encodeSound } from '../protocol.js';
import { STREAM_CODEC, accLevels, clientTables, decodeLevels, encodeBlocks, makeCodec, outTable, packCodes } from './codec.js';
import { lpcWeights } from './noise.js';

export const codec = makeCodec(STREAM_CODEC);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const yieldToLoop = () => new Promise(r => setImmediate(r));

export const MAX_SOUND_BYTES = 0xFFFFFF;

// Encode `target` (a multiple of 4 samples) and play it. Returns { how: 'done' | 'abort' | 'closed',
// codes } (codes: what was encoded, for a preview). options: { variant, delay, latch, lut,
// weight, adapt, log }. `conn.sound` is set by the caller before this (the screen is held
// from then), and cleared by it after.
export async function playOnC64(conn, target, { variant, delay, latch, lut, weight = [], adapt = null, log = () => {}, debug = () => {} }) {
  const n = target.length / 4;
  const parts = [];
  const ev = conn.sound;
  ev.credits = 0;
  let ended = null;
  const over = new Promise(resolve => { ev.end = how => { ended ??= how; resolve(how); }; });

  await conn.sendAndWait([
    ...encodePoke(SOUND_ADDR.DTAB, clientTables(codec).dtab),
    ...encodePoke(SOUND_ADDR.NIDX, clientTables(codec).nidx),
    ...encodePoke(SOUND_ADDR.OUTTAB, outTable(codec)),
    OP.FRAME,
  ]);
  if (ended) return { how: ended, codes: null };

  // No FRAME after SOUND: the C64 would take it for data.
  conn.sock.write(Buffer.from(encodeSound(variant, delay, latch, n)));
  const t0 = Date.now();
  let fifo = Buffer.alloc(0), sent = 0, scheduled = false;
  const flush = () => {
    if (ended) return;
    const k = Math.min(SOUND_WINDOW - (sent - ev.credits), fifo.length);
    if (k > 0) {
      conn.sock.write(fifo.subarray(0, k));
      fifo = fifo.subarray(k);
      sent += k;
    }
  };
  ev.onCredit = () => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => { scheduled = false; flush(); });
  };

  const progress = setInterval(() => debug(`sound: sent ${sent} of ${n}, credits ${ev.credits}, queued ${fifo.length}`), 1000);
  progress.unref();
  const weights = adapt ? lpcWeights(target, adapt) : weight;
  for (const codes of encodeBlocks(codec, target, lut, 256, 128, weights, adapt ? 0.02 : Infinity)) {
    if (ended) break;
    parts.push(codes);
    fifo = Buffer.concat([fifo, packCodes(codes, 2)]);
    flush();
    await yieldToLoop();
    while (fifo.length > 1024 && !ended) await sleep(5); // no more than about half a second ahead
  }
  while (!ended && sent < n) { await sleep(5); flush(); }
  const how = ended ?? await over;
  clearInterval(progress);
  ev.onCredit = null;
  log(`sound ${how}: ${sent} of ${n} bytes sent in ${((Date.now() - t0) / 1000).toFixed(2)} s`);
  const codes = new Uint8Array(parts.reduce((a, c) => a + c.length, 0));
  let at = 0;
  for (const c of parts) { codes.set(c, at); at += c.length; }
  return { how, codes };
}

// What the C64 plays for `codes`: its start state, then each code's output (for a preview WAV).
export function previewOf(codes, lut) {
  const out = new Float32Array(codes.length + 1);
  out[0] = accLevels(codec, lut)[64];
  out.set(decodeLevels(codec, codes, lut), 1);
  return out;
}
