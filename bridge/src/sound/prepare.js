// Turns a sound job (text to speak, a file to play, or the bytes of one) into the
// signal the encoder follows. It does the slow parts (a TTS program, ffmpeg, the
// resampling), so the bridge runs it in a worker thread, off the event loop that is
// serving the terminal.

import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAudio, prepare, speakDefault, speakWith } from './speech.js';

// job: { text, voice } | { path } | { data: Buffer }; options: { rate, lut, tts, voice, dsp }
// -> Float32Array at `rate` Hz.
export function prepareJob(job, { rate, lut = 'sid6581', tts = null, voice = null, dsp = {} }) {
  let audio;
  if (job.text !== undefined) {
    audio = tts ? speakWith(tts, job.text) : speakDefault(job.text, job.voice ?? voice);
  } else if (job.path !== undefined) {
    audio = loadAudio(job.path);
  } else if (job.data) {
    const dir = mkdtempSync(join(tmpdir(), 'petty-snd-'));
    try {
      const file = join(dir, 'in');
      writeFileSync(file, job.data);
      audio = loadAudio(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } else {
    throw new Error('nothing to play');
  }
  return prepare(audio, rate, { lut, ...dsp }).target;
}

// The same in a worker thread: resolves with the signal, or rejects with the error.
export function prepareInWorker(job, options) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./prepare-worker.js', import.meta.url), { workerData: { job, options } });
    worker.once('message', m => (m.error ? reject(new Error(m.error)) : resolve(m.target)));
    worker.once('error', reject);
    worker.once('exit', code => { if (code !== 0) reject(new Error(`sound worker exited (${code})`)); });
  });
}
