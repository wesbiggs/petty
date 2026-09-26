#!/usr/bin/env node
// Runs a command (default: claude) in a 40x25 pty, emulates the terminal
// headlessly, and streams screen diffs to a C64 over TCP (VICE's RS-232).

import net from 'node:net';
import { parseArgs } from 'node:util';
import pty from 'node-pty';
import xterm from '@xterm/headless';
import { COLS, ROWS, MSG, encodeFrame, encodeReset } from './protocol.js';
import { snapshot } from './screen.js';
import { keyToBytes, MATRIX } from './keymap.js';

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string', default: '6464' },
    host: { type: 'string', default: '127.0.0.1' },
    fps: { type: 'string', default: '20' },
    verbose: { type: 'boolean', short: 'v', default: false },
  },
});

const [cmd, ...cmdArgs] = positionals.length ? positionals : ['claude'];
const FRAME_MS = 1000 / Number(opt.fps);
const ACK_TIMEOUT_MS = 5000;
const SYNC_MAX_MS = 250; // don't wait forever on synchronized output

const log = (...a) => console.error('[bridge]', ...a);
const debug = (...a) => opt.verbose && log(...a);

// --- terminal session (survives C64 reconnects) ---------------------------

const term = new xterm.Terminal({ cols: COLS, rows: ROWS, scrollback: 200, allowProposedApi: true });
let proc = null;
let dirty = true;
let syncSince = 0;

function spawn() {
  term.reset();
  proc = pty.spawn(cmd, cmdArgs, {
    name: 'xterm-256color',
    cols: COLS,
    rows: ROWS,
    cwd: process.cwd(),
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });
  proc.onData(d => term.write(d));
  proc.onExit(({ exitCode }) => {
    log(`${cmd} exited (${exitCode})`);
    proc = null;
    term.write(`\r\n\x1b[0;33m[${cmd} exited - press RETURN to restart]\x1b[0m`);
  });
  log(`started ${cmd} ${cmdArgs.join(' ')}`);
}

// Replies to terminal queries (DA, DSR, ...) go back to the program.
term.onData(d => proc?.write(d));
term.onWriteParsed(() => { dirty = true; });

// --- C64 connection ----------------------------------------------------------

let conn = null;

class Connection {
  constructor(sock) {
    this.sock = sock;
    this.state = null; // null = C64 screen unknown, needs a reset
    this.inFlight = false;
    this.ackTimer = null;
    this.rx = [];
    this.bytesSent = 0;
    sock.setNoDelay(true);
    sock.on('data', d => this.onData(d));
    sock.on('close', () => this.close('closed'));
    sock.on('error', e => this.close(e.message));
  }

  close(why) {
    if (conn !== this) return;
    log(`C64 disconnected (${why})`);
    clearTimeout(this.ackTimer);
    conn = null;
  }

  onData(data) {
    this.rx.push(...data);
    while (this.rx.length) {
      const type = this.rx[0];
      if (type === MSG.ACK) {
        this.rx.shift();
        this.inFlight = false;
        clearTimeout(this.ackTimer);
      } else if (type === MSG.HELLO) {
        this.rx.shift();
        log('C64 says hello');
        this.state = null;
        this.inFlight = false;
        clearTimeout(this.ackTimer);
        dirty = true;
      } else if (type === MSG.KEY) {
        if (this.rx.length < 3) return;
        const [, code, mods] = this.rx.splice(0, 3);
        this.onKey(code, mods);
      } else {
        debug(`junk byte ${type}`);
        this.rx.shift();
      }
    }
  }

  onKey(code, mods) {
    const bytes = keyToBytes(code, mods, {
      appCursor: term.modes.applicationCursorKeysMode,
      // encoding isn't in the public API ('DEFAULT' | 'SGR' | 'SGR_PIXELS')
      mouse: {
        tracking: term.modes.mouseTrackingMode,
        encoding: term._core.coreMouseService.activeEncoding,
        altScreen: term.buffer.active.type === 'alternate',
      },
    });
    debug(`key ${MATRIX[code]} mods=${mods} -> ${JSON.stringify(bytes)}`);
    if (!bytes) return;
    if (bytes.scroll) {
      term.scrollLines(bytes.scroll);
      dirty = true;
      return;
    }
    // Typing jumps back to the live screen, like iTerm2.
    const buf = term.buffer.active;
    if (buf.viewportY !== buf.baseY) {
      term.scrollToBottom();
      dirty = true;
    }
    if (!proc) {
      if (bytes === '\r') spawn();
      return;
    }
    proc.write(bytes);
  }

  sendFrame() {
    const want = snapshot(term);
    const { bytes, state } = this.state ? encodeFrame(this.state, want) : encodeReset(want);
    this.state = state;
    if (bytes.length === 1) return; // only FRAME marker: nothing changed
    this.sock.write(Buffer.from(bytes));
    this.bytesSent += bytes.length;
    debug(`frame ${bytes.length} bytes`);
    this.inFlight = true;
    this.ackTimer = setTimeout(() => {
      log('ACK timeout - forcing full redraw');
      this.state = null;
      this.inFlight = false;
      dirty = true;
    }, ACK_TIMEOUT_MS);
  }
}

function tick() {
  if (!conn || conn.inFlight || !dirty) return;
  if (term.modes.synchronizedOutputMode) {
    syncSince ||= Date.now();
    if (Date.now() - syncSince < SYNC_MAX_MS) return;
  }
  syncSince = 0;
  dirty = false;
  conn.sendFrame();
}

const server = net.createServer(sock => {
  log(`C64 connected from ${sock.remoteAddress}:${sock.remotePort}`);
  if (conn) conn.sock.destroy();
  conn = new Connection(sock);
  dirty = true;
  if (!proc) spawn();
});

server.listen(Number(opt.port), opt.host, () => {
  log(`listening on ${opt.host}:${opt.port} - start VICE / the C64 client now`);
});

setInterval(tick, FRAME_MS);

const shutdown = () => { proc?.kill(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
