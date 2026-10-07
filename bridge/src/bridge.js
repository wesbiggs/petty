#!/usr/bin/env node
// Runs a command (default: $SHELL) in a pty the size of the client's screen
// (40x25 C64 text or hi-res; 80x25 C128 VDC or C64 soft 80 columns; or
// larger and panned),
// emulates the terminal headlessly, and streams screen diffs to the client
// over TCP (VICE's RS-232, or a WiFi modem) or a serial device (--serial).
//
// By default there is one session, which a client that connects takes over and
// which survives its reconnects. With --max-sessions N, every TCP connection
// gets a session of its own (a pty, a terminal, a program), which ends when
// the connection does, and a connection past N is refused.

import net from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pty from 'node-pty';
import xterm from '@xterm/headless';
import { DISPLAY, MSG, OP, VIEW, displayById, encodeFrame, encodeReset, encodePicture } from './protocol.js';
import { loadLut } from './sound/lut.js';
import { SoundManager } from './sound/manager.js';
import { classifyRegion } from './sound/probe.js';
import { loadCharset, charsFor, charsetCommands, reservedSlots, extRedraws } from './charset.js';
import { snapshot, paletteFor, cursorVisible } from './screen.js';
import { THEME_NAMES, stepTheme, oscReply } from './colors.js';
import { keyToBytes, MATRIX } from './keymap.js';
import { GlyphCache } from './glyphcache.js';
import { openSerial } from './serial.js';
import { InlineImages, multicolourPicture } from './image.js';
import { GameHardware } from './game.js';

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
    title: { type: 'string', default: fileURLToPath(new URL('../title.ans', import.meta.url)) },
    sound: { type: 'string', default: 'on' },
    tts: { type: 'string' },
    voice: { type: 'string' },
    'sound-weight': { type: 'string', default: '-0.6' },
    'sound-lut': { type: 'string', default: 'sid6581' },
    'sound-delay': { type: 'string' },
    'sound-out': { type: 'string' },
    charset: { type: 'string' },
    'max-sessions': { type: 'string' },
    'idle-timeout': { type: 'string', default: '0' },
    'on-exit': { type: 'string', default: 'restart' },
    'control-host': { type: 'string', default: '127.0.0.1' },
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

const MULTI = opt['max-sessions'] !== undefined; // a session for each connection
const MAX_SESSIONS = MULTI ? Number(opt['max-sessions']) : 1;
if (!(Number.isInteger(MAX_SESSIONS) && MAX_SESSIONS > 0)) {
  console.error(`[bridge] --max-sessions ${opt['max-sessions']}: use a whole number, 1 or more`);
  process.exit(1);
}
if (MULTI && opt.serial) {
  console.error('[bridge] --max-sessions: a serial line is one session');
  process.exit(1);
}
const IDLE_MS = Number(opt['idle-timeout']) * 1000; // 0 = never
if (!(IDLE_MS >= 0)) {
  console.error(`[bridge] --idle-timeout ${opt['idle-timeout']}: use seconds, or 0 for never`);
  process.exit(1);
}
if (!['restart', 'close'].includes(opt['on-exit'])) {
  console.error('[bridge] --on-exit restart or close');
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
const IMAGE_FRAME_BYTES = 2048; // hi-res frames split up past this (images), so keys stay responsive
const BIN = fileURLToPath(new URL('../bin', import.meta.url)); // imgcat, a fallback at the end of the program's PATH
const SOUND_BIN = fileURLToPath(new URL('../bin/sound', import.meta.url)); // say and play, which come first: they speak on the C64

// The start screen (bridge/title.ans, from scripts/gen-title.js), shown when a client
// first connects, before the program starts. --title none: no start screen.
let title = null;
if (opt.title && opt.title !== 'none') {
  try {
    title = readFileSync(opt.title, 'utf8') || null;
  } catch (e) {
    console.error(`[bridge] no start screen: ${e.message}`);
  }
}

let soundLut;
try { soundLut = loadLut(opt['sound-lut']); } catch (e) { console.error(`[bridge] ${e.message}`); process.exit(1); }
const soundOn = opt.sound !== 'off';
if (!['on', 'off'].includes(opt.sound)) { console.error('[bridge] --sound on or off'); process.exit(1); }

// --charset FILE: glyphs for the C64 text and hi-res clients (charset.js), sent after each of its resets.
let charset = null;
if (opt.charset) {
  try { charset = loadCharset(opt.charset); } catch (e) { console.error(`[bridge] ${e.message}`); process.exit(1); }
}

const clamp = (n, max) => Math.min(max, Math.max(0, n));
const log = (...a) => console.error('[bridge]', ...a);

// --- sessions -------------------------------------------------------------------
//
// A session is a terminal and the program in it, drawn on one client's screen.
// It survives that client's reconnects (a reset, a dropped call) unless
// --max-sessions gives every connection its own, which end with it.

const sessions = new Set();
let nextId = 1;

class Session {
  constructor() {
    this.id = nextId++;
    this.log = MULTI ? (...a) => log(`#${this.id}`, ...a) : log;
    this.debug = (...a) => opt.verbose && this.log(...a);
    this.conn = null;
    this.proc = null;
    this.started = false; // the program has been spawned at least once
    this.holding = null; // timer while the start screen shows
    this.dirty = true;
    this.syncSince = 0;
    this.destroyed = false;
    this.closeWhenIdle = false; // --on-exit close: hang up once the last screen is out
    // The client's screen, from its HELLO. Kept across reconnects.
    this.display = DISPLAY.C64;
    this.own = charset && charsFor(charset, this.display); // characters --charset gave their own codes
    this.panX = 0;
    this.panY = 0;
    // Changed by C=+F1 or the control port (scripts/petty-ctl.js).
    this.theme = opt.theme;
    this.term = new xterm.Terminal({ cols: this.termCols(), rows: this.termRows(), scrollback: 200, allowProposedApi: true });
    const { term } = this;
    // Replies to terminal queries (DA, DSR, ...) go back to the program.
    term.onData(d => this.proc?.write(d));
    // Colour queries get the theme's colours on the connected display, so
    // programs that pick light or dark by the background get it right.
    for (const code of [4, 10, 11]) {
      term.parser.registerOscHandler(code, data => {
        const reply = oscReply(code, data, paletteFor(this.display, this.theme));
        if (reply === null) return false;
        this.proc?.write(reply);
        return true;
      });
    }
    term.onWriteParsed(() => { this.dirty = true; });
    // Inline images (imgcat): drawn on the hi-res screen, as blocks
    // on the others. Transparency shows the theme's screen colour. On the
    // hi-res screen, a Koala picture (or any, with imgcat -t koala) shows full
    // screen, in multicolour, until a key is pressed.
    this.images = new InlineImages(term, () => {
      const vic = paletteFor(DISPLAY.C64_HIRES, this.theme);
      return { maxCols: this.display.cols, maxRows: this.display.rows, bg: vic.rgb[vic.screenBg] };
    }, this.log, (file, args) => {
      const pic = this.display.hires && this.conn && multicolourPicture(file, args);
      if (pic) this.conn.showPicture(pic);
      return !!pic;
    });
    term.parser.registerOscHandler(1337, data => this.images.osc(data));
    // Sound: say and play (bridge/bin/sound) ask for it with OSC 8347; see sound/manager.js. The C64 plays
    // it modally, the screen still, and whatever the program prints meanwhile is drawn after.
    this.sound = new SoundManager({
      log: this.log, debug: this.debug, enabled: soundOn,
      tts: opt.tts, voice: opt.voice,
      weight: opt['sound-weight'].split(',').filter(Boolean).map(Number),
      lut: soundLut, out: opt['sound-out'],
      delay: opt['sound-delay'] === undefined ? undefined : Number(opt['sound-delay']),
      getConn: () => this.conn,
      redraw: () => { this.dirty = true; },
      afterSound: () => this.game.audioLost(),
    });
    term.parser.registerOscHandler(8347, data => this.sound.osc(data));
    // Game hardware: sprites and the SID, OSC 8348 and 8349 (game.js), on a client that has them.
    this.game = new GameHardware({
      log: this.log,
      active: () => !!this.conn && !!this.display.game,
      kick: () => this.conn?.flushGame(),
      reply: text => this.proc?.write(text),
    });
    term.parser.registerOscHandler(8348, data => { this.dirty = true; return this.game.sprite(data); });
    term.parser.registerOscHandler(8349, data => { this.dirty = true; return this.game.sid(data); });
    sessions.add(this);
  }

  // A terminal wider (--cols) or taller (--rows) than the display is shown
  // through a window that C=+CRSR→ and CTRL+CRSR↓ move in half-screen steps
  // (0-39, 20-59, 40-79 for 80 columns on a C64).
  termCols() { return Math.max(this.display.cols, Number(opt.cols ?? 0)); }
  termRows() { return Math.max(this.display.rows, Number(opt.rows ?? 0)); }
  panMaxX() { return this.termCols() - this.display.cols; }
  panMaxY() { return this.termRows() - this.display.rows; }

  // A client takes over: the one before it, if any, is dropped.
  attach(sock) {
    this.conn?.sock.destroy();
    this.conn = new Connection(this, sock);
    this.dirty = true;
    if (this.proc || this.holding) return;
    if (this.started || !title) return this.spawn();
    this.showTitle();
    this.holding = setTimeout(() => this.spawn(), TITLE_MS);
  }

  // The client went away. A session of its own ends with it.
  onDisconnect() {
    if (MULTI) this.destroy();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.holding);
    this.holding = null;
    sessions.delete(this);
    this.sound.queue.length = 0;
    this.game.dispose();
    this.conn?.sound?.end?.('closed');
    this.proc?.kill();
    this.proc = null;
    this.term.dispose();
    const { conn } = this;
    if (conn) { this.conn = null; conn.sock.destroy(); }
    this.log('session ended');
  }

  spawn() {
    clearTimeout(this.holding);
    this.holding = null;
    this.started = true;
    // reset() leaves the cursor hidden if it was (by the start screen, or a
    // program that exited without showing it).
    this.term.reset();
    this.term.write('\x1b[?25h');
    const proc = pty.spawn(cmd, cmdArgs, {
      name: 'xterm-256color',
      cols: this.termCols(),
      rows: this.termRows(),
      cwd: process.cwd(),
      env: {
        ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor',
        PATH: `${soundOn ? `${SOUND_BIN}:` : ''}${process.env.PATH}:${BIN}`,
        ...(soundOn ? { PETTY_SOUND: '1' } : {}),
        PETTY_SESSION: String(this.id),
      },
    });
    this.proc = proc;
    proc.onData(d => { if (!this.destroyed) this.term.write(d); });
    proc.onExit(({ exitCode }) => {
      if (this.destroyed || this.proc !== proc) return;
      this.log(`${cmd} exited (${exitCode})`);
      this.proc = null;
      if (opt['on-exit'] === 'close') {
        this.closeWhenIdle = true;
        this.dirty = true;
        return;
      }
      this.term.write(`\r\n\x1b[0;33m[${cmd} exited - press RETURN to restart]\x1b[0m`);
    });
    this.log(`started ${cmd} ${cmdArgs.join(' ')}`);
  }

  // Draws the start screen, centred on a display wider than it.
  showTitle() {
    const pad = Math.max(0, Math.floor((this.display.cols - TITLE_COLS) / 2));
    const indent = pad ? `\x1b[${pad}C` : '';
    this.term.reset();
    // Hide the cursor (spawn shows it again). Indent after the leading
    // control sequences (clear the screen) and after every newline.
    this.term.write('\x1b[?25l' + title.replace(/^(?:\x1b\[[\d;?]*[A-Za-z])*/, m => m + indent).replaceAll('\n', '\n' + indent));
  }

  setDisplay(d) {
    if (d === this.display) return;
    this.display = d;
    this.own = charset && charsFor(charset, d);
    this.term.resize(this.termCols(), this.termRows());
    this.proc?.resize(this.termCols(), this.termRows());
    this.panX = Math.min(this.panX, this.panMaxX());
    this.panY = Math.min(this.panY, this.panMaxY());
    this.log(`display is ${d.name} ${d.cols}x${d.rows}, terminal ${this.termCols()}x${this.termRows()}`);
  }

  // A full redraw sets the new border and screen colours. Programs that asked
  // for the colours (OSC 10/11) at startup keep their answer until restarted.
  setTheme(name) {
    if (name === this.theme) return;
    this.theme = name;
    if (this.conn) this.conn.state = null;
    this.dirty = true;
    this.log(`theme is ${name}`);
  }

  tick() {
    const { conn } = this;
    if (!conn) return;
    if (IDLE_MS && !conn.sound && Date.now() - conn.lastKey > IDLE_MS) {
      this.log(`idle for ${opt['idle-timeout']} s - disconnecting`);
      conn.sock.destroy();
      return;
    }
    if (conn.inFlight || conn.sound) return; // a sound holds the screen
    if (conn.picture) return conn.sendPicture();
    if (!this.dirty) {
      if (this.closeWhenIdle) conn.sock.end(); // the program's last screen is out
      return;
    }
    if (this.term.modes.synchronizedOutputMode) {
      this.syncSince ||= Date.now();
      if (Date.now() - this.syncSince < SYNC_MAX_MS) return;
    }
    this.syncSince = 0;
    this.dirty = false;
    conn.sendFrame();
  }
}

// --- C64 connection ----------------------------------------------------------

class Connection {
  constructor(session, sock) {
    this.s = session;
    this.sock = sock;
    this.state = null; // null = C64 screen unknown, needs a reset
    this.inFlight = false;
    this.ackTimer = null;
    this.rx = [];
    this.bytesSent = 0;
    this.timeouts = 0; // in a row: a serial line has nobody on it until the C64 starts
    this.picture = null; // frames of a full-screen picture still to send, while it shows
    this.restore = false; // back from a picture: switch to the terminal screen
    this.since = Date.now();
    this.lastKey = Date.now(); // for --idle-timeout
    this.hasSound = false; // the client can play sound (its display says so)
    this.region = null; // PAL or NTSC, from PROBE
    this.sound = null; // while a sound plays: { credits, onCredit, end }; the screen waits
    this.ackWaiters = []; // callbacks for the next ACK (sendAndWait)
    sock.setNoDelay?.(true);
    sock.setKeepAlive?.(true, 30000); // a call that drops without a FIN still ends, and frees its session
    sock.on('data', d => this.onData(d));
    sock.on('close', () => this.close('closed'));
    sock.on('error', e => this.close(e.message));
  }

  close(why) {
    clearTimeout(this.ackTimer); // also for a connection that a newer one replaced
    const { s } = this;
    if (s.conn !== this) return;
    s.log(`client disconnected (${why})`);
    this.sound?.end?.('closed');
    for (const w of this.ackWaiters.splice(0)) w.reject(new Error('C64 disconnected'));
    s.conn = null;
    s.onDisconnect();
  }

  onData(data) {
    const { s } = this;
    this.rx.push(...data);
    while (this.rx.length) {
      const type = this.rx[0];
      if (type === MSG.ACK) {
        this.rx.shift();
        this.inFlight = false;
        this.timeouts = 0;
        clearTimeout(this.ackTimer);
        for (const w of this.ackWaiters.splice(0)) w.resolve();
      } else if (type === MSG.CREDIT) {
        this.rx.shift(); // thousands a second while a sound plays: no log
        if (this.sound) { this.sound.credits++; this.sound.onCredit?.(); }
      } else if (type === MSG.DONE || type === MSG.ABORT) {
        this.rx.shift();
        s.debug(type === MSG.DONE ? 'sound done' : 'sound stopped on the C64');
        this.sound?.end?.(type === MSG.DONE ? 'done' : 'abort');
      } else if (type === MSG.GLIDE) {
        this.rx.shift();
        s.game.glideDone();
      } else if (type === MSG.PROBE) {
        if (this.rx.length < 3) return;
        const [, lo, hi] = this.rx.splice(0, 3);
        this.region = classifyRegion(lo | hi << 8);
        s.log(`C64 is ${this.region.name} (${lo | hi << 8} cycles a frame)`);
      } else if (type === MSG.HELLO || type === MSG.HELLO_ON) {
        if (type === MSG.HELLO_ON && this.rx.length < 2) return;
        const [, id = DISPLAY.C64.id] = this.rx.splice(0, type === MSG.HELLO ? 1 : 2);
        const d = displayById(id);
        if (!d) s.log(`unknown display ${id}, assuming C64`);
        s.log(`${(d ?? DISPLAY.C64).name} says hello`);
        s.setDisplay(d ?? DISPLAY.C64);
        this.sound?.end?.('closed'); // the client restarted
        s.game.invalidate(); // with nothing in it: say all of it again (after display is set)
        this.hasSound = soundOn && !!s.display.sound;
        this.region = null;
        this.since = Date.now();
        this.lastKey = Date.now();
        if (this.hasSound) this.sock.write(Buffer.from([OP.PROBE]));
        if (s.holding) s.showTitle();
        this.state = null;
        this.picture = null;
        this.restore = false;
        this.inFlight = false;
        clearTimeout(this.ackTimer);
        s.dirty = true;
      } else if (type === MSG.KEY) {
        if (this.rx.length < 3) return;
        const [, code, mods] = this.rx.splice(0, 3);
        this.lastKey = Date.now();
        this.onKey(code, mods);
      } else {
        s.debug(`junk byte ${type}`);
        this.rx.shift();
      }
    }
  }

  onKey(code, mods) {
    const { s } = this;
    const { term, display } = s;
    // Any key ends a full-screen picture, and is not passed on.
    if (this.picture) {
      this.endPicture();
      return;
    }
    const bytes = keyToBytes(code, mods, {
      appCursor: term.modes.applicationCursorKeysMode,
      // encoding isn't in the public API ('DEFAULT' | 'SGR' | 'SGR_PIXELS')
      mouse: {
        tracking: term.modes.mouseTrackingMode,
        encoding: term._core.coreMouseService.activeEncoding,
        altScreen: term.buffer.active.type === 'alternate',
      },
    });
    s.debug(`key ${MATRIX[code]} mods=${mods} -> ${JSON.stringify(bytes)}`);
    if (!bytes) return;
    if (bytes.pan) {
      const x = clamp(s.panX + bytes.pan * display.cols / 2, s.panMaxX());
      if (x !== s.panX) { s.panX = x; s.dirty = true; s.debug(`pan to column ${x}`); }
      return;
    }
    if (bytes.panY) {
      const y = clamp(s.panY + bytes.panY * Math.floor(display.rows / 2), s.panMaxY());
      if (y !== s.panY) { s.panY = y; s.dirty = true; s.debug(`pan to row ${y}`); }
      return;
    }
    if (bytes.theme) {
      s.setTheme(stepTheme(s.theme, bytes.theme));
      return;
    }
    if (bytes.scroll) {
      term.scrollLines(bytes.scroll * SCROLL_LINES);
      s.dirty = true;
      return;
    }
    // Any other key ends the start screen, and is not passed on.
    if (s.holding) {
      s.spawn();
      return;
    }
    // Typing jumps back to the live screen, like iTerm2.
    const buf = term.buffer.active;
    if (buf.viewportY !== buf.baseY) {
      term.scrollToBottom();
      s.dirty = true;
    }
    // ...and, in a terminal taller than the display, to the cursor's row.
    const y = clamp(Math.min(buf.cursorY, Math.max(s.panY, buf.cursorY - display.rows + 1)), s.panMaxY());
    if (y !== s.panY && cursorVisible(term)) { s.panY = y; s.dirty = true; s.debug(`pan to row ${y}`); }
    if (!s.proc) {
      if (bytes === '\r' && !s.closeWhenIdle) s.spawn();
      return;
    }
    s.proc.write(bytes);
  }

  sendFrame() {
    const { s } = this;
    const { display } = s;
    const want = snapshot(s.term, s.panX, display, s.theme, s.panY, s.own);
    want.move &&= s.game.used; // MOVE, for a program that is a game (the search for one costs a little)
    const reset = !this.state;
    const pal = paletteFor(display, s.theme);
    // After a reset, reload the client's extended glyphs too.
    if (!this.state) this.glyphs = display.ext
      ? new GlyphCache(display, charset && reservedSlots(charset, display), charset && extRedraws(charset, display)) : null;
    const glyphs = this.glyphs?.place(want, this.state) ?? [];
    const colour = display.hires ? pal.defaultFg << 4 | pal.screenBg : pal.defaultFg;
    const budget = display.hires ? IMAGE_FRAME_BYTES : Infinity;
    let { bytes, state, partial } = this.state
      ? encodeFrame(this.state, want, budget)
      : encodeReset(want, pal.border, pal.screenBg, colour, budget);
    this.state = state;
    if (partial) s.dirty = true; // the rest goes in the next frame
    // Game hardware goes with the frame: the SID before the screen's changes, the sprites after them.
    const pre = s.game.takePre(), post = s.game.takePost();
    if (bytes.length === 1 && !pre.length && !post.length) return; // only FRAME marker: nothing changed
    bytes = pre.concat(bytes.slice(0, -1), post, bytes.slice(-1));
    bytes = glyphs.concat(bytes);
    if (reset && charset) bytes = charsetCommands(charset, display).concat(bytes);
    if (this.restore) bytes.unshift(OP.VIEW, VIEW.TERMINAL, 0);
    this.restore = false;
    this.send(bytes);
  }

  // Sound commands that should not wait for the next screen frame (a footstep), if the
  // C64 is free to take them.
  flushGame() {
    const { s } = this;
    if (this.inFlight || this.sound || this.picture || !s.display.game) return;
    const pre = s.game.takePre();
    if (pre.length) this.send([...pre, OP.FRAME]);
  }

  // A Koala picture ({bitmap, screen, colram, bg}), full screen until a key
  // is pressed. The terminal carries on meanwhile, unseen.
  showPicture(pic) {
    this.picture = encodePicture(pic, IMAGE_FRAME_BYTES);
  }

  // Sends the picture's next frame, if any are left.
  sendPicture() {
    const frame = this.picture.shift();
    if (frame) this.send(frame);
  }

  // Back to the terminal, redrawn in full (the picture overwrote it).
  endPicture() {
    this.picture = null;
    this.restore = true;
    this.state = null;
    this.s.dirty = true;
  }

  // A frame, and resolves on its ACK. (Rejects if the C64 goes away; if the ACK does not come, the
  // timeout below asks for a full redraw and this carries on: the C64 is not stuck on that.)
  sendAndWait(bytes) {
    return new Promise((resolve, reject) => {
      this.ackWaiters.push({ resolve, reject });
      this.send(bytes);
    });
  }

  // Resolves when no frame is in flight.
  async idle() {
    while (this.inFlight) await new Promise(r => setTimeout(r, 10));
  }

  send(bytes) {
    const { s } = this;
    this.sock.write(Buffer.from(bytes));
    this.bytesSent += bytes.length;
    s.debug(`frame ${bytes.length} bytes`);
    this.inFlight = true;
    clearTimeout(this.ackTimer); // an earlier frame's timer must not fire later
    this.ackTimer = setTimeout(() => {
      (this.timeouts++ ? s.debug : s.log)('ACK timeout - forcing full redraw');
      if (this.picture) this.endPicture();
      this.state = null;
      this.inFlight = false;
      s.dirty = true;
      s.game.invalidate(); // what was in the lost frame included
      for (const w of this.ackWaiters.splice(0)) w.resolve();
    }, ACK_TIMEOUT_MS);
  }
}

setInterval(() => { for (const s of sessions) s.tick(); }, FRAME_MS);

// --- listening ---------------------------------------------------------------

let shared = null; // the one session, unless every connection has its own

function accept(sock) {
  if (MULTI) {
    if (sessions.size >= MAX_SESSIONS) {
      log(`refused ${sock.remoteAddress}: ${MAX_SESSIONS} sessions already`);
      sock.destroy();
      return;
    }
    new Session().attach(sock);
  } else {
    shared ??= new Session();
    shared.attach(sock);
  }
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
  accept(sock);
}

if (opt.serial) {
  openSerialPort();
} else {
  net.createServer(sock => {
    log(`client connected from ${sock.remoteAddress}:${sock.remotePort}`);
    accept(sock);
  }).listen(Number(opt.port), opt.host, () => {
    log(`listening on ${opt.host}:${opt.port} - start VICE / the C64 client now${MULTI ? ` (up to ${MAX_SESSIONS} sessions)` : ''}`);
  });
}

// --- control port: one command per line, one reply line each -------------
//
// With one session, commands act on it. With several, `sessions` lists them and
// the others take a session first: `@3 theme amber`, `@3 say hello`, `@3 kick`.

function control(line) {
  let words = line.trim().split(/\s+/);
  if (words[0] === 'sessions') {
    return [...sessions].map(s => `#${s.id} ${s.conn ? s.display.name : 'no client'} ${s.theme}`).join('; ') || 'none';
  }
  let session;
  if (/^@\d+$/.test(words[0])) {
    session = [...sessions].find(s => s.id === Number(words[0].slice(1)));
    if (!session) return `error: no session ${words[0]}`;
    words = words.slice(1);
  } else if (sessions.size === 1) {
    [session] = sessions;
  } else {
    return sessions.size ? 'error: several sessions: say which, as @N (see: sessions)' : 'error: no session';
  }
  const [cmd, ...rest] = words;
  const arg = rest[0];
  if (cmd === 'say') return session.sound.add({ text: rest.join(' ') }), 'queued';
  if (cmd === 'play') return session.sound.add({ path: rest.join(' ') }), 'queued';
  if (cmd === 'kick') return session.destroy(), 'ended';
  if (cmd === 'theme') {
    if (!arg) return `${session.theme} (${THEME_NAMES.join(', ')})`;
    const name = arg === 'next' ? stepTheme(session.theme, 1) : arg === 'prev' ? stepTheme(session.theme, -1) : arg;
    if (!THEME_NAMES.includes(name)) return `error: unknown theme ${arg}: use ${THEME_NAMES.join(', ')}, next or prev`;
    session.setTheme(name);
    return session.theme;
  }
  return `error: unknown command ${cmd}: use sessions, [@N] theme [name|next|prev], say TEXT, play FILE or kick`;
}

// Loopback unless --control-host says otherwise: it can make the bridge play any file on the host.
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
  .listen(CONTROL_PORT, opt['control-host'], () => log(`control on ${opt['control-host']}:${CONTROL_PORT}`));

const shutdown = () => { for (const s of sessions) s.proc?.kill(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
