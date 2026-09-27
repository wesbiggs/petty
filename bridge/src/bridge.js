#!/usr/bin/env node
// Runs a command (default: $SHELL) in a pty the size of the client's screen
// (40x25 C64; 80x25 C128 VDC or C64 soft 80 columns; or wider and panned),
// emulates the terminal headlessly, and streams screen diffs to the client
// over TCP (VICE's RS-232).

import net from 'node:net';
import { parseArgs } from 'node:util';
import pty from 'node-pty';
import xterm from '@xterm/headless';
import { DISPLAY, MSG, displayById, encodeFrame, encodeReset } from './protocol.js';
import { snapshot, paletteFor } from './screen.js';
import { THEME_NAMES, oscReply } from './colors.js';
import { keyToBytes, MATRIX } from './keymap.js';

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string', default: '6464' },
    host: { type: 'string', default: '127.0.0.1' },
    fps: { type: 'string', default: '20' },
    theme: { type: 'string', default: 'dark' },
    cols: { type: 'string' },
    verbose: { type: 'boolean', short: 'v', default: false },
  },
});

if (!THEME_NAMES.includes(opt.theme)) {
  console.error(`[bridge] unknown theme ${opt.theme}: use ${THEME_NAMES.join(', ')}`);
  process.exit(1);
}

const [cmd, ...cmdArgs] = positionals.length ? positionals : [process.env.SHELL || '/bin/sh'];
const FRAME_MS = 1000 / Number(opt.fps);
const ACK_TIMEOUT_MS = 5000;
const SYNC_MAX_MS = 250; // don't wait forever on synchronized output

// The client's screen, from its HELLO. Kept across reconnects, like the session.
let display = DISPLAY.C64;

// A terminal wider than the display (--cols) is shown through a window that
// C=+CRSR→ moves in half-screen steps (0-39, 20-59, 40-79 for 80 columns on a C64).
const termCols = () => Math.max(display.cols, Number(opt.cols ?? 0));
const panMax = () => termCols() - display.cols;
let panX = 0;

const log = (...a) => console.error('[bridge]', ...a);
const debug = (...a) => opt.verbose && log(...a);

// --- terminal session (survives C64 reconnects) ---------------------------

const term = new xterm.Terminal({ cols: termCols(), rows: display.rows, scrollback: 200, allowProposedApi: true });
let proc = null;
let dirty = true;
let syncSince = 0;

function spawn() {
  term.reset();
  proc = pty.spawn(cmd, cmdArgs, {
    name: 'xterm-256color',
    cols: termCols(),
    rows: display.rows,
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

function setDisplay(d) {
  if (d === display) return;
  display = d;
  term.resize(termCols(), display.rows);
  proc?.resize(termCols(), display.rows);
  panX = Math.min(panX, panMax());
  log(`display is ${display.name} ${display.cols}x${display.rows}, terminal ${termCols()}x${display.rows}`);
}

// Replies to terminal queries (DA, DSR, ...) go back to the program.
term.onData(d => proc?.write(d));

// Colour queries get the theme's colours on the connected display, so
// programs that pick light or dark by the background get it right.
for (const code of [4, 10, 11]) {
  term.parser.registerOscHandler(code, data => {
    const reply = oscReply(code, data, paletteFor(display, opt.theme));
    if (reply === null) return false;
    proc?.write(reply);
    return true;
  });
}
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
    log(`client disconnected (${why})`);
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
      } else if (type === MSG.HELLO || type === MSG.HELLO_ON) {
        if (type === MSG.HELLO_ON && this.rx.length < 2) return;
        const [, id = DISPLAY.C64.id] = this.rx.splice(0, type === MSG.HELLO ? 1 : 2);
        const d = displayById(id);
        if (!d) log(`unknown display ${id}, assuming C64`);
        log(`${(d ?? DISPLAY.C64).name} says hello`);
        setDisplay(d ?? DISPLAY.C64);
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
    if (bytes.pan) {
      const x = Math.min(panMax(), Math.max(0, panX + bytes.pan * display.cols / 2));
      if (x !== panX) { panX = x; dirty = true; debug(`pan to column ${panX}`); }
      return;
    }
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
    const want = snapshot(term, panX, display, opt.theme);
    const pal = paletteFor(display, opt.theme);
    const { bytes, state } = this.state
      ? encodeFrame(this.state, want)
      : encodeReset(want, pal.border, pal.screenBg, pal.defaultFg);
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
  log(`client connected from ${sock.remoteAddress}:${sock.remotePort}`);
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
