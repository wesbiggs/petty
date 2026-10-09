// The bridge as a process: who may connect, and what survives a kick.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Decoder, MSG, OP } from '../src/protocol.js';

const BRIDGE = fileURLToPath(new URL('../src/bridge.js', import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function start(extra = []) {
  const port = await new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });
  const proc = spawn('node', [BRIDGE, '--port', String(port), '--title', 'none', '--sound', 'off', '--fps', '50', ...extra, '--', 'cat'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  proc.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 80 && !/control on/.test(log); i++) await sleep(50);
  return { port, proc, log: () => log, stop: () => proc.kill() };
}

// A client: decodes frames, ACKs them.
function client(port, bytes) {
  const dec = new Decoder();
  const sock = net.connect(port, '127.0.0.1', () => sock.write(Buffer.from(bytes)));
  let received = 0, closed = false;
  sock.on('data', d => { received += d.length; dec.feed(d); for (const b of d) if (b === OP.FRAME) sock.write(Buffer.from([MSG.ACK])); });
  sock.on('close', () => { closed = true; });
  sock.on('error', () => {});
  return { dec, sock, get received() { return received; }, get closed() { return closed; } };
}

const ctl = (port, line) => new Promise(ok => {
  const s = net.connect(port + 1, '127.0.0.1', () => s.write(line + '\n'));
  s.once('data', d => { ok(String(d).trim()); s.destroy(); });
});
const waitFor = async (pred, ms = 4000) => { for (let t = 0; t < ms && !pred(); t += 50) await sleep(50); return pred(); };

test('a TCP connection that does not open with HELLO is dropped: an HTTP body cannot type', async () => {
  const b = await start();
  try {
    const keys = [MSG.HELLO, MSG.KEY, 29, 0, MSG.KEY, 33, 0]; // "hi"
    const req = Buffer.concat([Buffer.from(`POST / HTTP/1.1\r\nHost: x\r\nContent-Length: ${keys.length}\r\n\r\n`), Buffer.from(keys)]);
    const c = client(b.port, req);
    assert.ok(await waitFor(() => c.closed), 'hung up');
    assert.equal(c.received, 0);
    // ...and a real client still gets in, and its keys reach the program.
    const ok = client(b.port, [MSG.HELLO, MSG.KEY, 29, 0, MSG.KEY, 33, 0]);
    assert.ok(await waitFor(() => ok.dec.glyph[0] === 8 && ok.dec.glyph[1] === 9), 'h and i echoed');
    ok.sock.destroy();
  } finally { b.stop(); }
});

test('the control port hangs up on an HTTP request instead of running its body lines', async () => {
  const b = await start();
  try {
    const c = client(b.port, [MSG.HELLO]);
    await waitFor(() => c.received > 0);
    const s = net.connect(b.port + 1, '127.0.0.1', () => s.write('POST / HTTP/1.1\r\nHost: x\r\n\r\nkick\n'));
    let out = '';
    s.on('data', d => { out += d; });
    await new Promise(r => s.on('close', r));
    assert.match(out, /^error/);
    assert.match(await ctl(b.port, 'sessions'), /^#1 /, 'the session was not kicked');
    c.sock.destroy();
  } finally { b.stop(); }
});

test('after kick, a new client gets a session again', async () => {
  const b = await start();
  try {
    const c1 = client(b.port, [MSG.HELLO]);
    await waitFor(() => c1.received > 0);
    assert.equal(await ctl(b.port, 'kick'), 'ended');
    assert.ok(await waitFor(() => c1.closed));
    const c2 = client(b.port, [MSG.HELLO]);
    assert.ok(await waitFor(() => c2.received > 0), 'the new client is drawn on');
    assert.match(await ctl(b.port, 'sessions'), /^#\d+ /);
    c2.sock.destroy();
  } finally { b.stop(); }
});
