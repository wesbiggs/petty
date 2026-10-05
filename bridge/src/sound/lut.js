// --sound-lut: the SID's output for each volume 0-15, scaled to -1..1. A name from
// dsp.js (sid6581, sid8580), or a JSON file from scripts/sound-calibrate.js (an
// object with `levels`, or just the 16 numbers) measured from a real machine.

import { readFileSync } from 'node:fs';
import { LUTS } from './dsp.js';

export function loadLut(spec) {
  if (LUTS[spec]) return LUTS[spec];
  let json;
  try { json = JSON.parse(readFileSync(spec, 'utf8')); }
  catch (e) { throw new Error(`--sound-lut ${spec}: not one of ${Object.keys(LUTS).join(', ')} or a readable JSON file (${e.code ?? e.message})`); }
  const lut = Array.isArray(json) ? json : json.levels;
  if (!Array.isArray(lut) || lut.length !== 16 || !lut.every(v => Number.isFinite(v) && v >= -1.001 && v <= 1.001)) {
    throw new Error(`--sound-lut ${spec}: expected 16 levels between -1 and 1`);
  }
  if (lut.some((v, k) => k && v <= lut[k - 1])) throw new Error(`--sound-lut ${spec}: the levels must rise with the volume`);
  return lut;
}
