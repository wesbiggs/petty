#!/usr/bin/env node
// Measures the SID's 16 volume levels from a recording of c64/staircase.s (make
// build/staircase.prg; run it on the C64 and record its audio output, with a
// line-in: a microphone hears the speaker and the room, and many recorders
// compress or gate). The output is AC coupled (a high-pass near 16 Hz), so a
// held level droops away: what is measured is the jump at each step, level k to
// k+1 on the way up and back down, four times each. The jumps add up to each
// level, scaled to -1..1. Recording level does not matter, the shape of the
// recorder's response does. Prints how far the four measurements of a step
// disagree: a clean recording has a few percent.
//
//   node bridge/scripts/sound-calibrate.js recording.wav [--ntsc] [--json my-sid.json]
//   node bridge/src/bridge.js --sound-lut my-sid.json ...

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseWav } from '../src/sound/wav.js';

export function calibrate(y, fs, { ntsc = false } = {}) {
  const cpu = ntsc ? 1022727 : 985248;
  const per = 256 * 123 / cpu * fs; // recorded samples a level lasts
  const lo = Math.max(2, Math.round(fs * 1e-4)), hi = Math.max(lo + 3, Math.round(fs * 3e-4));
  const avg = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += y[i]; return s / (b - a); };
  const jumpAt = t => avg(t + lo, t + hi) - avg(t - hi, t - lo);

  // The start: the leader's 15 -> 0 is the steepest fall in the recording (15 steps; the staircase's are 1).
  // A step is smeared over a few samples by the recorder, so look for the best average step.
  let best = 0, at = -1;
  for (let t = hi; t < y.length - hi; t++) {
    const j = jumpAt(t);
    if (j < best) { best = j; at = t; }
  }
  if (at < 0) throw new Error('no staircase found in the recording');
  // the edge: the middle of the steepest part around the best average step
  let start = at, slope = 0;
  for (let t = at - hi; t <= at + hi; t++) if (y[t + 1] - y[t] < slope) { slope = y[t + 1] - y[t]; start = t + 0.5; }

  const seq = [...Array.from({ length: 16 }, (_, k) => k), ...Array.from({ length: 15 }, (_, k) => 14 - k)];
  const plateaus = [...seq, ...seq];
  if (start + (plateaus.length) * per > y.length) throw new Error('the recording ends before the staircase does');
  const meas = Array.from({ length: 15 }, () => []);
  for (let j = 1; j < plateaus.length; j++) {
    const from = plateaus[j - 1], to = plateaus[j];
    if (Math.abs(to - from) !== 1) continue;
    const jump = jumpAt(Math.round(start + j * per));
    meas[Math.min(from, to)].push(to > from ? jump : -jump);
  }
  const d = meas.map(m => m.reduce((a, b) => a + b, 0) / m.length);
  const out = [0];
  d.forEach(v => out.push(out.at(-1) + v));
  const min = Math.min(...out), max = Math.max(...out), swing = max - min;
  const levels = out.map(v => 2 * (v - min) / swing - 1);
  // how far the four measurements of each step differ, as a fraction of a mean step
  const spread = Math.max(...meas.map((m, k) => (Math.max(...m) - Math.min(...m)) / Math.abs(d[k])));
  return { levels, steps: d, swing, spread, start: start / fs };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const { values: opt, positionals: [path] } = parseArgs({ allowPositionals: true, options: { ntsc: { type: 'boolean', default: false }, json: { type: 'string' } } });
  if (!path) { console.error('usage: sound-calibrate.js recording.wav [--ntsc] [--json FILE]'); process.exit(1); }
  const { rate, pcm } = parseWav(readFileSync(path));
  let r;
  try { r = calibrate(pcm, rate, { ntsc: opt.ntsc }); } catch (e) { console.error(e.message); process.exit(1); }
  console.log(`staircase found at ${r.start.toFixed(3)} s`);
  console.log('step    jump');
  r.steps.forEach((v, k) => console.log(`${String(k).padStart(2)}->${String(k + 1).padEnd(2)} ${v.toFixed(5).padStart(8)}`));
  console.log(`\nswing ${r.swing.toFixed(4)} of the recording's full scale; the four measurements of a step differ by up to ${(r.spread * 100).toFixed(0)}% of it`);
  if (r.spread > 0.3) console.log('that is a lot: is it a clean line-in recording, with no compression or gain control, and the whole staircase in it? (--ntsc on an NTSC machine)');
  console.log(`[${r.levels.map(v => v.toFixed(3)).join(', ')}]`);
  if (opt.json) { writeFileSync(opt.json, JSON.stringify({ levels: r.levels, swing: r.swing, spread: r.spread }, null, 1) + '\n'); console.log(`wrote ${opt.json}: --sound-lut ${opt.json}`); }
}
