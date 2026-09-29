// Turns a self-showing picture program (a .prg that unpacks and displays a
// picture, as many releases are) into a picture file imgcat can send: runs
// it in VICE, waits for a bitmap screen, dumps the C64's memory through
// VICE's remote monitor, and finds the picture from the VIC's registers.
// Multicolour becomes Koala Painter (.koa), hi-res becomes Doodle! (.dd).
// Pictures that need raster tricks (FLI, interlace, sprites over the
// bitmap) come out as whatever is in memory, without them.
//
// usage: node scripts/prg2pic.js [--timeout S] [--settle S] picture.prg [out]
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    timeout: { type: 'string', default: '60' }, // seconds to wait for a picture
    settle: { type: 'string', default: '2' }, // seconds it must stay the same
  },
});
if (!positionals.length) {
  console.error('usage: node scripts/prg2pic.js [--timeout S] [--settle S] picture.prg [out]');
  process.exit(2);
}
const input = resolve(positionals[0]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.error('[prg2pic]', ...a);

// A free TCP port for the monitor.
const freePort = () => new Promise((ok, fail) => {
  const srv = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => ok(port));
  }).on('error', fail);
});

// Runs monitor commands, each after the monitor's prompt; the machine is
// stopped while connected. `resume`: leave with x (else the commands end it).
async function monitor(port, cmds, resume = true) {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((ok, fail) => sock.once('connect', ok).once('error', fail));
  let text = '';
  sock.on('data', d => { text += d; });
  const prompt = async () => {
    for (let t = 0; t < 100 && !/\(C:\$[0-9a-f]{4}\) $/i.test(text); t++) await sleep(50);
    const out = text;
    text = '';
    return out;
  };
  let out = '';
  for (const cmd of [...cmds, ...(resume ? ['x'] : [])]) {
    out += await prompt();
    sock.write(cmd + '\n');
  }
  await sleep(100);
  sock.destroy();
  if (/error/i.test(out + text)) throw new Error(`monitor: ${(out + text).trim()}`);
}

const work = mkdtempSync(join(tmpdir(), 'prg2pic-'));
copyFileSync(input, join(work, 'in.prg'));
const port = await freePort();
// Paths in monitor commands stay short: VICE runs in the work directory.
const vice = spawn('x64sc', [
  '+sound', '-warp', '-autostartprgmode', '1', '-autostart', 'in.prg',
  '-remotemonitor', '-remotemonitoraddress', `ip4://127.0.0.1:${port}`,
], { cwd: work, stdio: 'ignore' });
vice.on('error', e => { log(`can't run x64sc: ${e.message}`); process.exit(1); });

// The VIC's registers and colour RAM, and all 64K of RAM.
async function dump() {
  await monitor(port, ['bank io', 'bsave "io.bin" 0 d000 dfff', 'bank ram', 'bsave "ram.bin" 0 0000 ffff']);
  return { io: readFileSync(join(work, 'io.bin')), ram: readFileSync(join(work, 'ram.bin')) };
}

// Where the VIC shows a bitmap from, or null if it isn't showing one.
function picture({ io, ram }) {
  const d011 = io[0x11], d016 = io[0x16], d018 = io[0x18];
  if (!(d011 & 0x20) || !(d011 & 0x10)) return null; // not bitmap mode, or blanked
  const base = (3 - (io[0xd00] & 3)) * 0x4000; // $DD00 bits 0-1, inverted
  const screen = base + (d018 >> 4) * 0x400, bitmap = base + (d018 & 8) * 0x400;
  return {
    multicolour: !!(d016 & 0x10),
    bitmap: ram.subarray(bitmap, bitmap + 8000),
    screen: ram.subarray(screen, screen + 1000),
    colram: io.subarray(0x800, 0x800 + 1000).map(c => c & 15),
    bg: io[0x21] & 15,
    where: `bitmap $${bitmap.toString(16)}, screen $${screen.toString(16)}`,
  };
}

const key = p => p && Buffer.concat([p.bitmap, p.screen, p.colram, Buffer.from([p.bg, p.multicolour])]).toString('base64');

let pic = null;
try {
  await sleep(1500); // VICE starting up
  const until = Date.now() + Number(opt.timeout) * 1000;
  let last = null, since = 0;
  while (Date.now() < until) {
    await sleep(500);
    let p;
    try { p = picture(await dump()); } catch { continue; } // monitor not up yet
    const k = key(p);
    if (!p || k !== last) { last = k; since = Date.now(); continue; }
    if (Date.now() - since >= Number(opt.settle) * 1000) { pic = p; break; }
  }
  await monitor(port, ['quit'], false).catch(() => {});
} finally {
  vice.kill();
  rmSync(work, { recursive: true, force: true });
}
if (!pic) {
  log(`no bitmap picture on screen within ${opt.timeout} s`);
  process.exit(1);
}

let file, ext;
if (pic.multicolour) {
  // Koala Painter: load address $6000, bitmap, screen, colour RAM, background.
  file = Buffer.concat([Buffer.from([0x00, 0x60]), pic.bitmap, pic.screen, pic.colram, Buffer.from([pic.bg])]);
  ext = '.koa';
} else {
  // Doodle!: load address $5C00, screen and bitmap, padded to 1K and 8K.
  file = Buffer.concat([Buffer.from([0x00, 0x5c]), pic.screen, Buffer.alloc(24), pic.bitmap, Buffer.alloc(192)]);
  ext = '.dd';
}
const out = positionals[1] ?? join(dirname(input), basename(input).replace(/\.prg$/i, '') + ext);
writeFileSync(out, file);
log(`${pic.multicolour ? 'multicolour' : 'hi-res'} picture (${pic.where}) -> ${out}`);
