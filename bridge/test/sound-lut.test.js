import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLut } from '../src/sound/lut.js';
import { LUTS } from '../src/sound/dsp.js';
import { calibrate } from '../scripts/sound-calibrate.js';

test('loadLut: a name, a file of levels, and bad input', () => {
  assert.equal(loadLut('sid8580'), LUTS.sid8580);
  const dir = mkdtempSync(join(tmpdir(), 'lut-'));
  const good = join(dir, 'a.json');
  writeFileSync(good, JSON.stringify({ levels: LUTS.sid6581 }));
  assert.deepEqual(loadLut(good), LUTS.sid6581);
  writeFileSync(good, JSON.stringify(LUTS.sid8580));
  assert.deepEqual(loadLut(good), LUTS.sid8580);
  const bad = join(dir, 'b.json');
  writeFileSync(bad, JSON.stringify(LUTS.sid6581.slice(1)));
  assert.throws(() => loadLut(bad), /16 levels/);
  writeFileSync(bad, JSON.stringify([...LUTS.sid6581].reverse()));
  assert.throws(() => loadLut(bad), /rise/);
  assert.throws(() => loadLut(join(dir, 'missing.json')), /--sound-lut/);
});

// The staircase as a recorder would hear it: AC coupled (a 16 Hz high-pass), at another gain, with
// noise, 44.1 kHz, and a lead-in and tail of noise.
test('calibrate recovers the levels from a noisy AC-coupled recording of the staircase', () => {
  const fs = 44100, cpu = 985248, truth = LUTS.sid6581;
  const per = 256 * 123 / cpu * fs;
  const seq = [...Array.from({ length: 16 }, (_, k) => k), ...Array.from({ length: 15 }, (_, k) => 14 - k)];
  const plateaus = [8, 15, 15, ...seq, ...seq];
  const lead = Math.round(1.2 * fs), n = lead + Math.round(plateaus.length * per) + fs;
  const y = new Float32Array(n);
  let hp = 0, prev = 0, seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
  const k = 1 - 2 * Math.PI * 16 / fs; // one-pole high-pass
  for (let i = 0; i < n; i++) {
    const p = Math.min(plateaus.length - 1, Math.max(0, Math.floor((i - lead + per) / per)));
    const x = i < lead ? truth[8] : truth[plateaus[p]];
    hp = k * (hp + x - prev); prev = x;
    y[i] = 0.3 * hp + 0.002 * rnd();
  }
  const r = calibrate(y, fs);
  for (let v = 0; v < 16; v++) assert.ok(Math.abs(r.levels[v] - truth[v]) < 0.03, `level ${v}: ${r.levels[v]} against ${truth[v]}`);
  assert.ok(r.spread < 0.3, `spread ${r.spread}`);
});
