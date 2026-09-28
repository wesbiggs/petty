#!/usr/bin/env node
// Runs a command (default: $SHELL) in a pty the size of the client's screen
// (40x25 C64 text or hi-res; 80x25 C128 VDC or C64 soft 80 columns; or
// larger and panned),
// emulates the terminal headlessly, and streams screen diffs to the client
// over TCP (VICE's RS-232, or a WiFi modem) or a serial device (--serial).

import net from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pty from 'node-pty';
import xterm from '@xterm/headless';
import { DISPLAY, MSG, displayById, encodeFrame, encodeReset } from './protocol.js';
import { snapshot, paletteFor, cursorVisible } from './screen.js';
import { THEME_NAMES, stepTheme, oscReply } from './colors.js';
import { keyToBytes, MATRIX } from './keymap.js';
import { GlyphCache } from './glyphcache.js';
import { openSerial } from './serial.js';

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string', default: '6464' },
    host: { type: 'string', default: '127.0.0.1' },
    fps: { type: 'string', default: '20' },
    theme: { type: 'string', default: 'dark' },
    control: { type: 'string' },
    serial: { type: 'string' },
    baud: { type: 'string', default: '38400' },
    cols: { type: 'string' },
    rows: { type: 'string' },
    scroll: { type: 'string', default: '1' },
    title: { type: 'string', default: fileURLToPath(new URL('../../title.ans', import.meta.url)) },
    verbose: { type: 'boolean', short: 'v', default: false },
  },
});

if (!THEME_NAMES.includes(opt.theme)) {
  console.error(`[bridge] unknown theme ${opt.theme}: use ${THEME_NAMES.join(', ')}`);
  process.exit(1);
}

if (!(Number.isInteger(Number(opt.scroll)) && Number(opt.scroll) > 0)) {
  console.error(`[bridge] --scroll ${opt.scroll}: use a whole number of lines, 1 or more`);
  process.exit(1);
}

const [cmd, ...cmdArgs] = positionals.length ? positionals : [process.env.SHELL || '/bin/sh'];
const CONTROL_PORT = Number(opt.control ?? Number(opt.port) + 1);
const FRAME_MS = 1000 / Number(opt.fps);
const SCROLL_LINES = Number(opt.scroll); // per C=+CRSR press, in the bridge's scrollback
const ACK_TIMEOUT_MS = 5000;
const SERIAL_RETRY_MS = 2000;
const SYNC_MAX_MS = 250; // don't wait forever on synchronized output
const TITLE_MS = 4000; // how long the start screen shows, unless a key is pressed
const TITLE_COLS = 40;

// The start screen (title.ans, from scripts/gen-title.js), shown when a client
// first connects, before the program starts. --title none: no start screen.
let title = null;
if (opt.title && opt.title !== 'none') {
  try {
    title = readFileSync(opt.title, 'utf8') || null;
  } catch (e) {
    console.error(`[bridge] no start screen: ${e.message}`);
  }
}

// The client's screen, from its HELLO. Kept across reconnects, like the session.
let display = DISPLAY.C64;

// A terminal wider (--cols) or taller (--rows) than the display is shown
// through a window that C=+CRSR→ and CTRL+CRSR↓ move in half-screen steps
// (0-39, 20-59, 40-79 for 80 columns on a C64).
const termCols = () => Math.max(display.cols, Number(opt.cols ?? 0));
const termRows = () => Math.max(display.rows, Number(opt.rows ?? 0));
const panMaxX = () => termCols() - display.cols;
const panMaxY = () => termRows() - display.rows;
let panX = 0, panY = 0;

// Changed by C=+F1 or the control port (scripts/petty-ctl.js).
let theme = opt.theme;

const clamp = (n, max) => Math.min(max, Math.max(0, n));
const log = (...a) => console.error('[bridge]', ...a);
const debug = (...a) => opt.verbose && log(...a);

// --- terminal session (survives C64 reconnects) ---------------------------

const term = new xterm.Terminal({ cols: termCols(), rows: termRows(), scrollback: 200, allowProposedApi: true });
let proc = null;
let started = false; // the program has been spawned at least once
let holding = null; // timer while the start screen shows
let dirty = true;
let syncSince = 0;

function spawn() {
  clearTimeout(holding);
  holding = null;
  started = true;
  // reset() leaves the cursor hidden if it was (by the start screen, or a
  // program that exited without showing it).
  term.reset();
  term.write('\x1b[?25h');
  proc = pty.spawn(cmd, cmdArgs, {
    name: 'xterm-256color',
    cols: termCols(),
    rows: termRows(),
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

// Draws the start screen, centred on a display wider than it.
function showTitle() {
  const pad = Math.max(0, Math.floor((display.cols - TITLE_COLS) / 2));
  const indent = pad ? `\x1b[${pad}C` : '';
  term.reset();
  // Hide the cursor (spawn shows it again). Indent after the leading
  // control sequences (clear the screen) and after every newline.
  term.write('\x1b[?25l' + title.replace(/^(?:\x1b\[[\d;?]*[A-Za-z])*/, m => m + indent).replaceAll('\n', '\n' + indent));
}

function setDisplay(d) {
  if (d === display) return;
  display = d;
  term.resize(termCols(), termRows());
  proc?.resize(termCols(), termRows());
  panX = Math.min(panX, panMaxX());
  panY = Math.min(panY, panMaxY());
  log(`display is ${display.name} ${display.cols}x${display.rows}, terminal ${termCols()}x${termRows()}`);
}

// A full redraw sets the new border and screen colours. Programs that asked
// for the colours (OSC 10/11) at startup keep their answer until restarted.
function setTheme(name) {
  if (name === theme) return;
  theme = name;
  if (conn) conn.state = null;
  dirty = true;
  log(`theme is ${theme}`);
}

// Replies to terminal queries (DA, DSR, ...) go back to the program.
term.onData(d => proc?.write(d));

// Colour queries get the theme's colours on the connected display, so
// programs that pick light or dark by the background get it right.
for (const code of [4, 10, 11]) {
  term.parser.registerOscHandler(code, data => {
    const reply = oscReply(code, data, paletteFor(display, theme));
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
    this.timeouts = 0; // in a row: a serial line has nobody on it until the C64 starts
    sock.setNoDelay?.(true);
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
        this.timeouts = 0;
        clearTimeout(this.ackTimer);
      } else if (type === MSG.HELLO || type === MSG.HELLO_ON) {
        if (type === MSG.HELLO_ON && this.rx.length < 2) return;
        const [, id = DISPLAY.C64.id] = this.rx.splice(0, type === MSG.HELLO ? 1 : 2);
        const d = displayById(id);
        if (!d) log(`unknown display ${id}, assuming C64`);
        log(`${(d ?? DISPLAY.C64).name} says hello`);
        setDisplay(d ?? DISPLAY.C64);
        if (holding) showTitle();
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
      const x = clamp(panX + bytes.pan * display.cols / 2, panMaxX());
      if (x !== panX) { panX = x; dirty = true; debug(`pan to column ${panX}`); }
      return;
    }
    if (bytes.panY) {
      const y = clamp(panY + bytes.panY * Math.floor(display.rows / 2), panMaxY());
      if (y !== panY) { panY = y; dirty = true; debug(`pan to row ${panY}`); }
      return;
    }
    if (bytes.theme) {
      setTheme(stepTheme(theme, bytes.theme));
      return;
    }
    if (bytes.scroll) {
      term.scrollLines(bytes.scroll * SCROLL_LINES);
      dirty = true;
      return;
    }
    // Any other key ends the start screen, and is not passed on.
    if (holding) {
      spawn();
      return;
    }
    // Typing jumps back to the live screen, like iTerm2.
    const buf = term.buffer.active;
    if (buf.viewportY !== buf.baseY) {
      term.scrollToBottom();
      dirty = true;
    }
    // ...and, in a terminal taller than the display, to the cursor's row.
    const y = clamp(Math.min(buf.cursorY, Math.max(panY, buf.cursorY - display.rows + 1)), panMaxY());
    if (y !== panY && cursorVisible(term)) { panY = y; dirty = true; debug(`pan to row ${panY}`); }
    if (!proc) {
      if (bytes === '\r') spawn();
      return;
    }
    proc.write(bytes);
  }

  sendFrame() {
    const want = snapshot(term, panX, display, theme, panY);
    const pal = paletteFor(display, theme);
    // After a reset, reload the client's extended glyphs too.
    if (!this.state) this.glyphs = display.ext ? new GlyphCache(display) : null;
    const glyphs = this.glyphs?.place(want, this.state) ?? [];
    const colour = display.hires ? pal.defaultFg << 4 | pal.screenBg : pal.defaultFg;
    let { bytes, state } = this.state
      ? encodeFrame(this.state, want)
      : encodeReset(want, pal.border, pal.screenBg, colour);
    this.state = state;
    if (bytes.length === 1) return; // only FRAME marker: nothing changed
    bytes = glyphs.concat(bytes);
    this.sock.write(Buffer.from(bytes));
    this.bytesSent += bytes.length;
    debug(`frame ${bytes.length} bytes`);
    this.inFlight = true;
    this.ackTimer = setTimeout(() => {
      (this.timeouts++ ? debug : log)('ACK timeout - forcing full redraw');
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

function attach(sock) {
  if (conn) conn.sock.destroy();
  conn = new Connection(sock);
  dirty = true;
  if (proc || holding) return;
  if (started || !title) return spawn();
  showTitle();
  holding = setTimeout(spawn, TITLE_MS);
}

// A serial device is one connection for good: reopened if it goes away (a
// USB adapter unplugged).
let serialError = null;
function openSerialPort() {
  let sock;
  try {
    sock = openSerial(opt.serial, Number(opt.baud));
  } catch (e) {
    if (e.message !== serialError) log(`${e.message} - retrying until it opens`);
    serialError = e.message;
    setTimeout(openSerialPort, SERIAL_RETRY_MS);
    return;
  }
  serialError = null;
  log(`opened ${opt.serial} at ${opt.baud} baud - start the C64 client now`);
  sock.on('close', () => setTimeout(openSerialPort, SERIAL_RETRY_MS));
  attach(sock);
}

if (opt.serial) {
  openSerialPort();
} else {
  net.createServer(sock => {
    log(`client connected from ${sock.remoteAddress}:${sock.remotePort}`);
    attach(sock);
  }).listen(Number(opt.port), opt.host, () => {
    log(`listening on ${opt.host}:${opt.port} - start VICE / the C64 client now`);
  });
}

// --- control port: one command per line, one reply line each -------------

function control(line) {
  const [cmd, arg] = line.trim().split(/\s+/);
  if (cmd === 'theme') {
    if (!arg) return `${theme} (${THEME_NAMES.join(', ')})`;
    const name = arg === 'next' ? stepTheme(theme, 1) : arg === 'prev' ? stepTheme(theme, -1) : arg;
    if (!THEME_NAMES.includes(name)) return `error: unknown theme ${arg}: use ${THEME_NAMES.join(', ')}, next or prev`;
    setTheme(name);
    return theme;
  }
  return `error: unknown command ${cmd}: use theme [name|next|prev]`;
}

net.createServer(sock => {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', d => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) sock.write(control(line) + '\n');
    }
  });
  sock.on('error', () => {});
}).on('error', e => log(`control port: ${e.message}`))
  .listen(CONTROL_PORT, opt.host, () => log(`control on ${opt.host}:${CONTROL_PORT}`));

setInterval(tick, FRAME_MS);

const shutdown = () => { proc?.kill(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
