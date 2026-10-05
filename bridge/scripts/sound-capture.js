#!/usr/bin/env node
// Plays a sound on the hi-res client in VICE through the whole path (a command to the
// bridge's control port, as `say` would make by OSC), records VICE's sound, and scores it against
// the signal the encoder was given (sound-score.js). VICE shows its window. The bridge
// runs `sleep` as its program, so nothing else draws.
//
//   node bridge/scripts/sound-capture.js [--say "text" | --play file] [--delay N] [--sid 0|1] [--model c64|ntsc]
//   node bridge/scripts/sound-capture.js --sweep 0-12 ...      each --delay in a range

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: opt } = parseArgs({ options: {
  say: { type: 'string', default: 'The quick brown fox jumps over the dog. Hello, I am a Commodore sixty four.' },
  play: { type: 'string' },
  delay: { type: 'string' },
  sweep: { type: 'string' },
  sid: { type: 'string', default: '0' },
  model: { type: 'string', default: 'c64' },
  prg: { type: 'string', default: 'build/pettyhires.prg' },
  out: { type: 'string', default: 'build/sound' },
  port: { type: 'string', default: '6464' },
  keep: { type: 'boolean', default: false },
  verbose: { type: 'boolean', default: false },
} });
const here = p => fileURLToPath(new URL(p, import.meta.url));
mkdirSync(opt.out, { recursive: true });
const preview = `${opt.out}/preview.wav`, recording = `${opt.out}/vice.wav`;

async function once(delay) {
  rmSync(preview, { force: true });
  const args = [here('../src/bridge.js'), '--port', opt.port, '--title', 'none', '--sound-out', preview, ...(delay === undefined ? [] : ['--sound-delay', String(delay)]), '-v', '--', 'sleep', '600'];
  const bridge = spawn('node', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  const waiters = [];
  bridge.stderr.on('data', d => {
    log += d;
    if (opt.verbose) process.stderr.write(d);
    for (const w of [...waiters]) if (w.re.test(log)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(); }
  });
  const until = (re, ms) => new Promise((resolve, reject) => {
    if (re.test(log)) return resolve();
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${re}\n${log.split('\n').slice(-8).join('\n')}`)), ms);
    waiters.push({ re, resolve: () => { clearTimeout(t); resolve(); } });
  });
  await new Promise(r => setTimeout(r, 800));
  rmSync(recording, { force: true });
  const c128 = /128/.test(opt.prg); // the C128 client: VICE's x128 with the VDC (80 columns)
  const vice = spawn(c128 ? 'x128' : 'x64sc', [
    ...(c128 ? ['-80col'] : ['-model', opt.model]), '-acia1', '-acia1mode', '1', '-acia1base', '0xDE00', '-acia1irq', '1', '-myaciadev', '0',
    '-rsdev1', `127.0.0.1:${opt.port}`, '+rsdev1ip232', '-rsdev1baud', '38400', '-sidmodel', opt.sid,
    '-soundrecdev', 'wav', '-soundrecarg', recording, '+warp', '-autostart', opt.prg,
  ], { stdio: 'ignore' });
  try {
    await until(/C64 is (PAL|NTSC)/, 60000);
    const ctl = spawnSync('node', [here('./petty-ctl.js'), '--port', String(Number(opt.port) + 1), ...(opt.play ? ['play', opt.play] : ['say', opt.say])], { encoding: 'utf8' });
    if (ctl.status !== 0) throw new Error(ctl.stderr);
    await until(/sound (done|abort|closed)/, 300000);
    await new Promise(r => setTimeout(r, 1500));
  } finally {
    vice.kill();
    bridge.kill();
    await new Promise(r => vice.once('exit', r));
  }
  return log;
}

async function run(delay) {
  const log = await once(delay);
  const how = /sound (done|abort|closed)[^\n]*/.exec(log)?.[0] ?? 'no result';
  if (!existsSync(preview)) return `${how}: no preview written`;
  const target = preview.replace(/\.wav$/, '') + '.target.wav';
  const r = spawnSync('node', [here('./sound-score.js'), target, recording], { encoding: 'utf8' });
  const m = /speech band[^:]*: correlation ([-\d.]+), SNR ([-\d.]+) dB; after a fractional delay of [-\d.]+ samples: ([-\d.]+) dB/.exec(r.stdout);
  return m ? `${how}\n  vs the speech: correlation ${m[1]}, speech-band SNR ${m[2]} dB (${m[3]} dB with the delay removed)` : `${how}\n${r.stdout}${r.stderr}`;
}

if (opt.sweep) {
  const [a, b] = opt.sweep.split('-').map(Number);
  for (let d = a; d <= b; d++) console.log(`delay ${String(d).padStart(2)}: ${(await run(d)).split('\n').pop().trim()}`);
} else {
  console.log(await run(opt.delay === undefined ? undefined : Number(opt.delay)));
}
