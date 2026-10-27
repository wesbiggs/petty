// A C64 client in VICE (x64sc), with the caller as its bridge: VICE's emulated SwiftLink dials a TCP port here,
// and VICE's remote monitor reads its memory. For the vice-*-check.js scripts.
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, copyFileSync, rmSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { MSG } from '../src/protocol.js';

export const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((ok, fail) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }).on('error', fail); });

// Starts `prg`. `keep`: leave its work directory (screenshots, dumps) when stopped.
export async function startVice(prg, { keep = false, log = console.error } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'petty-mode-'));
  copyFileSync(prg, join(work, 'petty.prg'));
  const linkPort = await freePort(), monPort = await freePort();
  const c = { rx: [], sock: null, work };
  const waiters = [];
  c.link = net.createServer(s => {
    c.sock = s;
    s.on('data', d => { c.rx.push(...d); for (const w of [...waiters]) w(); });
  }).listen(linkPort, '127.0.0.1');
  c.waitFor = async (pred, what, ms = 20000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const r = pred();
      if (r) return r;
      await new Promise(res => { waiters.push(res); setTimeout(res, 50); });
      waiters.length = 0;
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  // The next n bytes from the client. `ms` for the first bytes after a start, where VICE has a
  // machine to boot and a program to autostart: more than a wait gets by default.
  c.read = async (n, what, ms) => { await c.waitFor(() => c.rx.length >= n, what, ms); return c.rx.splice(0, n); };
  c.vice = spawn('x64sc', [
    // VICE 3.10 crashes logging to a stdout that is not a terminal, as it is here
    '+logtostdout', '-logfile', join(work, 'vice.log'),
    '-autostartprgmode', '1', '-autostart', 'petty.prg',
    '-acia1', '-acia1mode', '1', '-acia1base', '0xDE00', '-acia1irq', '1', '-myaciadev', '0',
    '-rsdev1', `127.0.0.1:${linkPort}`, '+rsdev1ip232', '-rsdev1baud', '38400',
    '-sound', '-sounddev', 'dummy',
    '-remotemonitor', '-remotemonitoraddress', `ip4://127.0.0.1:${monPort}`,
  ], {
    cwd: work,
    // VICE's own stderr: what it says when it will not start at all.
    stdio: ['ignore', 'ignore', openSync(join(work, 'vice.err'), 'w')],
  });
  c.vice.on('error', e => { log(`can't run x64sc: ${e.message}`); process.exit(2); });
  c.monitor = async cmds => {
    const s = net.connect(monPort, '127.0.0.1');
    await new Promise((ok, fail) => s.once('connect', ok).once('error', fail));
    let text = '';
    s.on('data', d => { text += d; });
    const prompt = async () => {
      for (let t = 0; t < 100 && !/\(C:\$[0-9a-f]{4}\) $/i.test(text); t++) await sleep(50);
      text = '';
    };
    for (const cmd of [...cmds, 'x']) { await prompt(); s.write(cmd + '\n'); }
    await sleep(100);
    s.destroy();
  };
  // All of RAM, and the I/O area (VIC, SID, colour RAM).
  c.machine = async () => {
    await c.monitor(['bank io', 'bsave "io.bin" 0 d000 dfff', 'bank ram', 'bsave "ram.bin" 0 0000 ffff']);
    const io = readFileSync(join(work, 'io.bin')), ram = readFileSync(join(work, 'ram.bin'));
    rmSync(join(work, 'io.bin')); rmSync(join(work, 'ram.bin'));
    return { io, ram };
  };
  // A frame (ending in FRAME), and its ACK.
  c.frame = async bytes => {
    c.sock.write(Buffer.from(bytes));
    const ack = await c.read(1, 'ACK');
    assert.deepEqual(ack, [MSG.ACK], 'ACK');
  };
  c.stop = () => {
    if (keep || process.env.PETTY_KEEP) return log(`kept ${work}`);
    c.vice.kill();
    c.link.close();
    rmSync(work, { recursive: true, force: true });
  };
  return c;
}

// Runs fn(name) for each check, logging and counting: { check, done() } (done exits with 1 if any failed).
export function checks(log) {
  const results = [];
  return {
    async check(name, fn) {
      try { await fn(); results.push([name, true]); log(`ok   ${name}`); } catch (e) { results.push([name, false]); log(`FAIL ${name}: ${e.message}`); }
    },
    done() {
      const failed = results.filter(([, ok]) => !ok).length;
      log(`${results.length - failed} passed, ${failed} failed`);
      process.exit(failed ? 1 : 0);
    },
  };
}
