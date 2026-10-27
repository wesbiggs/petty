// What the VICE tests share: the clients, VICE with an emulated SwiftLink and its remote
// monitor, and the other end of the SwiftLink (a pretend bridge, or a pretend WiFi modem
// in front of one). VICE runs without warp, as a real machine would.
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { DISPLAY, MSG, OP } from '../../src/protocol.js';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const BUILD = process.env.PETTY_BUILD ?? join(ROOT, 'build');
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const freePort = () => new Promise((ok, fail) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }).on('error', fail);
});
const canListen = port => new Promise(ok => {
  const s = net.createServer().listen(port, '127.0.0.1', () => s.close(() => ok(true))).on('error', () => ok(false));
});

// A free port whose next one is free too, for the bridge: it listens on `port` and, for control, on port + 1.
// Taking both keeps that second port out of the free ports a VICE monitor is given while tests run together.
export async function freePortPair() {
  for (let t = 0; t < 100; t++) {
    const port = await freePort();
    if (await canListen(port + 1)) return port;
  }
  throw new Error('no two ports next to each other are free');
}

// The clients: their program, emulator, display, and where the KERNAL keeps the held key's matrix code. The C64
// client is one program whose four screens are switched with MODE (`switches`); the C128 client has the one.
export const CLIENTS = {
  c64: { prg: 'petty.prg', emu: 'x64sc', display: DISPLAY.C64, curkey: 0xCB, switches: true },
  hires: { prg: 'petty.prg', emu: 'x64sc', display: DISPLAY.C64_HIRES, curkey: 0xCB, switches: true },
  soft80: { prg: 'petty.prg', emu: 'x64sc', display: DISPLAY.C64_80, curkey: 0xCB, switches: true },
  soft53: { prg: 'petty.prg', emu: 'x64sc', display: DISPLAY.C64_53, curkey: 0xCB, switches: true },
  c128: { prg: 'petty128.prg', emu: 'x128', display: DISPLAY.C128, curkey: 0xD4 },
};

// What the C64 client's MODES says it can switch to (c64/main.s MODES_MASK).
export const MODES_MASK = 0x80 | 1 << DISPLAY.C64.id | 1 << DISPLAY.C64_80.id | 1 << DISPLAY.C64_HIRES.id | 1 << DISPLAY.C64_53.id;

// Waits for a client's hello and leaves it on c.display. The C64 client boots on the screen `make START` chose and
// says which others it has (MODES), so a MODE follows: it clears the screen and says HELLO_ON and MODES again. Used
// after RUN/STOP+RESTORE too, which starts it over on START's screen.
export async function hello(l, c, ms = 60000) {
  await l.until(() => l.take(MSG.HELLO_ON), 'HELLO_ON', ms);
  if (!c.switches) return void await l.until(() => l.take(c.display.id), `display ${c.display.id}`);
  await l.until(() => l.take(MSG.MODES), 'MODES');
  await sleep(300); // the mask, and whatever the screen it booted on sent
  l.rx.length = 0;
  l.write([OP.MODE, c.display.id]);
  await l.until(() => l.rx.length >= 4, `HELLO_ON after MODE ${c.display.key}`);
  assert.deepEqual(l.rx.splice(0, 4), [MSG.HELLO_ON, c.display.id, MSG.MODES, MODES_MASK], `the switch to ${c.display.key}`);
}

// Waits for pred() to be truthy, re-checking when `wake` is called and every 50 ms.
function waiter() {
  const waiting = new Set();
  return {
    wake: () => { for (const w of waiting) w(); },
    async until(pred, what, ms = 15000) {
      const end = Date.now() + ms;
      for (;;) {
        const r = pred();
        if (r) return r;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await new Promise(res => { const t = setTimeout(done, 50); function done() { clearTimeout(t); waiting.delete(done); res(); } waiting.add(done); });
      }
    },
  };
}

// The other end of the SwiftLink. `rx` holds what the client sent and `take` removes one byte of it (its messages
// are a byte each, here). With `modem`, it first behaves as a Hayes modem: `lines` collects the commands, ATD answers
// CONNECT, and +++ goes back to the command line, where ATH hangs up.
export async function link({ modem = false } = {}) {
  const port = await freePort();
  const w = waiter();
  const self = {
    port, rx: [], lines: [], online: !modem, sock: null,
    take(b) { const i = self.rx.indexOf(b); if (i < 0) return false; self.rx.splice(i, 1); return true; },
    until: w.until,
    write(bytes) { self.sock.write(Buffer.from(bytes)); },
    close() { self.sock?.destroy(); server.close(); },
  };
  let line = '';
  const server = net.createServer(s => {
    self.sock?.destroy();
    self.sock = s;
    s.on('error', () => {});
    s.on('data', d => {
      for (const b of d) {
        if (self.online) {
          self.rx.push(b);
          // A modem leaves the call for its command line on +++ (the client sends no other '+' here).
          if (modem && self.rx.slice(-3).every(x => x === 0x2B) && self.rx.length >= 3) {
            self.rx.splice(-3);
            self.online = false;
            setTimeout(() => s.write('\r\nOK\r\n'), 1000);
          }
          continue;
        }
        if (b !== 13) { line += String.fromCharCode(b); continue; }
        const cmd = line.trim().toUpperCase();
        line = '';
        if (!cmd) continue;
        self.lines.push(cmd);
        if (/^ATD/.test(cmd)) { s.write('\r\nCONNECT 38400\r\n'); self.online = true; }
        else s.write('\r\nOK\r\n');
      }
      w.wake();
    });
  }).listen(port, '127.0.0.1');
  return self;
}

// Starts a client in VICE, its SwiftLink connected to 127.0.0.1:port. `sound`: a file for VICE's SID dump.
export async function vice(client, { port, prg, sound, args = [] } = {}) {
  const c = CLIENTS[client];
  prg ??= join(BUILD, c.prg);
  if (!existsSync(prg)) throw new Error(`${prg} is not built: run make`);
  const work = mkdtempSync(join(tmpdir(), `petty-vice-${client}-`));
  copyFileSync(prg, join(work, basename(prg)));
  const monPort = await freePort();
  const proc = spawn(c.emu, [
    '-default', ...(c.emu === 'x128' ? ['-80col'] : []),
    // VICE 3.10 crashes logging to a stdout that is not a terminal
    '+logtostdout', '-logfile', join(work, 'vice.log'),
    '-autostartprgmode', '1', '-autostart', basename(prg),
    '-acia1', '-acia1mode', '1', '-acia1base', '0xDE00', '-acia1irq', '1', '-myaciadev', '0',
    '-rsdev1', `127.0.0.1:${port}`, '+rsdev1ip232', '-rsdev1baud', '38400',
    ...(sound ? ['-sound', '-sounddev', 'dump', '-soundarg', sound] : ['-sounddev', 'dummy']),
    '-remotemonitor', '-remotemonitoraddress', `ip4://127.0.0.1:${monPort}`,
    ...args,
  ], { cwd: work, stdio: 'ignore' });
  let exited = false;
  const exit = new Promise(r => proc.once('exit', () => { exited = true; r(); }));
  proc.once('error', e => { console.error(`can't run ${c.emu}: ${e.message}`); });

  // One connection to the monitor, kept: a command sent just after a connection closes can be lost.
  let mon = null, text = '';
  const connect = async () => {
    for (let t = 0; ; t++) {
      const s = net.connect(monPort, '127.0.0.1');
      try { await new Promise((ok, fail) => s.once('connect', ok).once('error', fail)); }
      catch (e) { if (t > 100 || exited) throw e; await sleep(100); continue; }
      s.on('data', d => { text += d; });
      s.on('error', () => {});
      return s;
    }
  };

  const self = {
    client, work, proc, exit,
    get exited() { return exited; },
    // Runs monitor commands, each when the one before has finished, and returns what the monitor said. The machine
    // is stopped from the first command until x; `resume` sends x.
    async monitor(cmds, resume = true) {
      mon ??= await connect();
      text = '';
      // The monitor stops the machine when it is sent something, and prompts once for that and once after each command.
      const prompts = () => (text.match(/\(C:\$[0-9a-f]{4}\) /gi) ?? []).length;
      for (const [k, cmd] of cmds.entries()) {
        mon.write(cmd + '\n');
        for (let t = 0; t < 1000 && prompts() < k + 2; t++) await sleep(10);
        if (prompts() < k + 2) throw new Error(`monitor: no prompt after ${cmd}: ${text}`);
      }
      if (resume) mon.write('x\n');
      return text;
    },
    // Memory, as bank: address range pairs, e.g. { ram: [0, 0xffff], io: [0xd000, 0xdfff] }.
    async dump(ranges) {
      const cmds = [], files = {};
      for (const [bank, [from, to]] of Object.entries(ranges)) {
        files[bank] = join(work, `${bank}.bin`);
        rmSync(files[bank], { force: true }); // bsave won't overwrite
        cmds.push(`bank ${bank}`, `bsave "${bank}.bin" 0 ${from.toString(16)} ${to.toString(16)}`);
      }
      await self.monitor([...cmds, 'bank cpu']);
      const out = {};
      for (const [bank, file] of Object.entries(files)) out[bank] = readFileSync(file);
      return out;
    },
    // All of RAM and the I/O area (VIC, SID, colour RAM), as the game tests want them.
    machine: () => self.dump({ io: [0xD000, 0xDFFF], ram: [0, 0xFFFF] }),
    // Asks VICE to quit (so it writes what it records), and waits until it has.
    async quit() {
      if (exited) return;
      mon ??= await connect();
      mon.write('quit\n');
      await Promise.race([exit, sleep(10000)]);
      if (!exited) proc.kill('SIGKILL');
    },
    async stop() {
      mon?.destroy();
      if (!exited) { proc.kill(); await Promise.race([exit, sleep(5000)]); if (!exited) proc.kill('SIGKILL'); }
      if (process.env.PETTY_KEEP) console.error(`kept ${work}`);
      else rmSync(work, { recursive: true, force: true });
    },
  };
  return self;
}
