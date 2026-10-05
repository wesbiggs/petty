// Sound for the terminal: what a program in it can ask for (OSC 8347, below) and
// the queue that plays it, one at a time, on the C64.
//
//   ESC ] 8347 ; say  ; <base64 text>  [; voice=NAME] BEL    speak the text
//   ESC ] 8347 ; play ; <base64 path>                BEL    play a file on the bridge's host
//   ESC ] 8347 ; data ; <base64 file contents>       BEL    play an audio file sent inline
//                                                           (for a program on another host)
//   ESC ] 8347 ; stop                                BEL    drop what is queued
//
// (bridge/bin/sound/say and play send these.) The first two need the file or the
// TTS on the bridge's host; the third needs only the terminal. Playing is modal:
// see session.js. The current sound can be stopped with RUN/STOP on the C64; the
// bridge cannot stop it, because the C64 is not listening for commands while it
// plays.

import { statSync, writeFileSync } from 'node:fs';
import { LUTS } from './dsp.js';
import { lineTimer } from './timing.js';
import { prepareInWorker } from './prepare.js';
import { MAX_SOUND_BYTES, playOnC64, previewOf } from './session.js';
import { writeWav } from './wav.js';

const MAX_TEXT = 4000;
const MAX_DATA = 32 << 20;

// Where in a raster line the C64's sample timer starts, in 5-cycle steps, found
// by measuring the writes' timing in VICE with the hi-res client's screen on
// (scripts/sound-capture.js, sweep-phase). PAL machine, NTSC machine.
export const SOUND_DELAY = { pal: 4, ntsc: 4 };

export class SoundManager {
  // options: { log, enabled, tts, voice, weight, lut, out, delay, getConn, redraw }
  constructor(options) {
    this.o = options;
    this.queue = [];
    this.running = false;
  }

  // The OSC's payload (after "8347;"). Returns true if it was ours.
  osc(data) {
    if (!this.o.enabled) return true; // swallowed: not shown as garbage
    const [verb, b64, ...rest] = data.split(';');
    const extras = Object.fromEntries(rest.filter(r => r.includes('=')).map(r => [r.slice(0, r.indexOf('=')), r.slice(r.indexOf('=') + 1)]));
    try {
      if (verb === 'say') {
        const text = Buffer.from(b64 ?? '', 'base64').toString('utf8').trim();
        if (text) this.add({ text: text.slice(0, MAX_TEXT), voice: extras.voice });
      } else if (verb === 'play') {
        this.add({ path: Buffer.from(b64 ?? '', 'base64').toString('utf8') });
      } else if (verb === 'data') {
        const buf = Buffer.from(b64 ?? '', 'base64');
        if (buf.length > MAX_DATA) throw new Error('too big');
        this.add({ data: buf });
      } else if (verb === 'stop') {
        this.queue.length = 0;
        this.o.log('sound queue cleared');
      } else {
        this.o.log(`sound: unknown OSC 8347 command ${verb}`);
      }
    } catch (e) {
      this.o.log(`sound: ${e.message}`);
    }
    return true;
  }

  add(job) {
    if (job.path !== undefined) {
      // a regular file only: not a device or a fifo, whatever a program in the terminal asks for
      try {
        if (!statSync(job.path).isFile()) throw new Error('not a file');
      } catch (e) {
        this.o.log(`sound: cannot play ${JSON.stringify(job.path)}: ${e.message}`);
        return;
      }
    }
    this.queue.push(job);
    this.o.log(`sound queued: ${job.text !== undefined ? JSON.stringify(job.text.slice(0, 40)) : job.path ?? `${job.data.length} bytes`}`);
    this.pump();
  }

  async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift();
        try {
          await this.play(job);
        } catch (e) {
          this.o.log(`sound: ${e.message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  async play(job) {
    const conn = await this.waitForConn();
    if (!conn) throw new Error('no C64 (or one without sound) to play on');
    const region = conn.region;
    if (region.lineCycles !== 63 && region.lineCycles !== 65) throw new Error(`${region.name} machines (${region.lineCycles}-cycle raster lines) are not supported`);
    const { latch, rate } = lineTimer(2, region.lineCycles, region.cpuHz);
    const lut = LUTS[this.o.lut];
    // The slow part (a TTS program, ffmpeg, resampling) while the terminal carries on.
    const signal = await prepareInWorker(job, { rate, lut: this.o.lut, tts: this.o.tts, voice: this.o.voice });
    if (signal.length < 4) throw new Error('nothing to play');
    const target = new Float32Array(Math.ceil(signal.length / 4) * 4);
    target.set(signal);
    if (target.length / 4 > MAX_SOUND_BYTES) throw new Error('too long');
    const live = this.o.getConn();
    if (!live || live !== conn) throw new Error('the C64 went away');
    // From here the screen is held: no frames until it is over.
    conn.sound = { credits: 0, onCredit: null, end: null };
    try {
      await conn.idle();
      const { how, codes } = await playOnC64(conn, target, {
        variant: region.lineCycles === 63 ? 0 : 1,
        delay: this.o.delay ?? SOUND_DELAY[region.lineCycles === 63 ? 'pal' : 'ntsc'],
        latch, lut, weight: this.o.weight, log: this.o.log, debug: this.o.debug,
      });
      if (this.o.out && codes) {
        writeFileSync(this.o.out, writeWav(previewOf(codes, lut), rate));
        writeFileSync(`${this.o.out}.rate`, String(rate));
        const targetFile = this.o.out.replace(/\.wav$/, '') + '.target.wav';
        writeFileSync(targetFile, writeWav(target, rate));
        writeFileSync(`${targetFile}.rate`, String(rate));
      }
      if (how === 'abort') this.queue.length = 0; // RUN/STOP means stop, not skip
    } finally {
      conn.sound = null;
      this.o.redraw();
    }
  }

  // The connection to play on, once the client has answered PROBE (which is how a client
  // that has no sound is told from one that has): waits for one.
  async waitForConn() {
    for (let i = 0; i < 100; i++) {
      const conn = this.o.getConn();
      if (conn?.hasSound && conn.region) return conn;
      await new Promise(r => setTimeout(r, 100));
    }
    return null;
  }
}
