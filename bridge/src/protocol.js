// Wire protocol between the bridge and the C64 client.
//
// Host -> C64 (the C64 keeps a write pointer and a current colour):
//   01 row col         GOTO     move write pointer
//   02 color           COLOR    set current colour (C64: 0-15; C128: VDC attribute,
//                               RGBI in bits 0-3, bit 5 underline, bit 6 reverse,
//                               bit 7 characters 256-511; C64 hi-res:
//                               foreground << 4 | background)
//   03 n g1..gn        PUT      write n screen codes, advancing
//   04 n g             REPEAT   write screen code g n times
//   05 top bot n       SCROLL   scroll rows top..bot up by n, clear with spaces
//   06 border bg       COLORS   set $D020/$D021
//   07                 CLS      clear screen with spaces, pointer to 0,0
//   08                 FRAME    end of frame; C64 answers ACK
//   09 n col row color d1..d63  SPRITE  (soft 80 columns) show hardware sprite
//                               n (0-7) with 24x21 pixels d, its top left
//                               corner on character col, row
//   0A n               NOSPRITE hide sprite n
//   0B lo hi d0..d7    GLYPH    redefine character lo + 256 * hi as 8 rows of
//                               pixels: 128-255 on the C64 hi-res screen (cells
//                               already drawn keep their pixels), 128-511 on the
//                               C128 (cells showing it change)
//   0C on              UNDERLINE (C64 hi-res) underline what PUT and REPEAT
//                               write from now on (0 = off)
//   0D n (d0..d7 color)*n  BITS (C64 hi-res) write n cells of raw pixels, each
//                               8 bitmap bytes and its colour, advancing
//   0E mode bg         VIEW     (C64 hi-res) 1: blank the screen in colour bg and
//                               switch to multicolour, to load a picture; 2: show
//                               it; 0: back to the hi-res terminal screen (the
//                               host then redraws it)
//   0F lo hi n d1..dn  POKE     (C64 hi-res) write n bytes (0 = 256) at lo + 256 * hi
//   10 var delay lat_lo lat_hi n_lo n_hi n_ex
//                      SOUND    (C64 hi-res) play n bytes of 2-bit codes (4 samples each; see
//                               sound/codec.js) that follow the command as raw bytes: modally,
//                               the screen on and still. var 0: 63-cycle raster lines (PAL),
//                               1: 65 (NTSC); delay: where in a raster line the sample timer
//                               starts, in 5 cycles; latch: the CIA timer's, a whole number of
//                               lines. The bridge sends 128 bytes and one more for each CREDIT,
//                               and loads the code's tables first, with POKE at DTAB, NIDX and
//                               OUTTAB (sound/session.js). No FRAME follows: it would be data.
//   11                 PROBE    measure the machine: the C64 answers PROBE
//   12 slot d1..d63    SPRDEF   (C64 text) shape for hardware sprite shape slot 0-31 (see game.js)
//   13 n slot color flags xlo y
//                      SPR      (C64 text) sprite n (0-7) shows shape `slot` at x = xlo + 256 * flags
//                               bit 0, y (the VIC's coordinates: 24, 50 is the top left of the
//                               text); flags bit 1 on, 2 multicolour, 3 wide, 4 tall, 5 behind text
//   14 n frames dx dy  GLIDE    (C64 text) sprite n moves by (dx, dy), signed pixels, every frame
//                               for `frames` frames; the C64 sends GLIDE when all have ended
//   15 x y w h dx dy   MOVE     (C64 text) copy the w x h cells at x, y (codes and colours) to
//                               x + dx, y + dy (signed), all at once
//   16 n (reg val)*n   SIDW     (C64 text) write SID registers now
//   17 ch lo hi m0..m3 SIDPLAY  (C64 text) start the SID script at lo + 256 * hi on channel
//                               0-3; its writes are limited to the registers in the 25-bit mask
//   18 ch              SIDSTOP  (C64 text) stop channel ch (255: all), gates down
//   19                 SIDRESET (C64 text) stop all channels, zero the SID
//   1A c1 c2           SPRMC    (C64 text) the sprites' two shared multicolour colours
//   (opcodes are in hexadecimal above 9; the numbers are in OP below)
//
// C64 -> host:
//   01                 ACK      frame processed
//   02 key mods        KEY      matrix code 0-63, mods bit0 shift, bit1 C=, bit2 ctrl
//   03                 HELLO    C64 client (re)started; host sends a full redraw
//   04 display         HELLO_ON same, from a client on another display (DISPLAY ids)
//   05                 DONE     SOUND finished
//   06                 CREDIT   SOUND: one byte of codes taken from the C64's buffer
//   07 c_lo c_hi       PROBE    the cycles in a video frame: 19656 PAL, 17095 NTSC
//   08                 ABORT    SOUND stopped by RUN/STOP; the C64 has thrown away what
//                               was in flight, so the bridge may carry on at once
//   09                 GLIDE    every sprite glide has ended
//
// Rows and columns are those of the client's display: 40x25 on the C64, 80x25
// on the C128's VDC and on the C64's soft 80-column bitmap screen. The write
// pointer wraps at the end of the screen. `pair`: two neighbouring cells share
// one colour (the bridge makes them equal). `hires`: every cell has its own
// foreground and background, and there is no inverse half of the character
// set; a colour's bit 8 is underline, sent with UNDERLINE. `reverse`:
// inverse video is an attribute (VDC.RVS), not a character.
// `ext`: characters from 128 up are extended glyphs, loaded with GLYPH.
// Glyphs from IMAGE up are cells of inline images (image.js), sent with BITS.

import { IMAGE, imageCell } from './image.js';

export const DISPLAY = {
  C64: { id: 0, name: 'C64', cols: 40, rows: 25, sound: true, game: true },
  C128: { id: 1, name: 'C128 VDC', cols: 80, rows: 25, reverse: true, ext: true, sound: true },
  C64_80: { id: 2, name: 'C64 soft-80', cols: 80, rows: 25, pair: true, sound: true },
  C64_HIRES: { id: 3, name: 'C64 hi-res', cols: 40, rows: 25, hires: true, ext: true, sound: true },
};
export const displayById = id => Object.values(DISPLAY).find(d => d.id === id);

// C64 defaults, for callers that only deal with one screen size.
export const COLS = DISPLAY.C64.cols;
export const ROWS = DISPLAY.C64.rows;
export const CELLS = COLS * ROWS;

export const OP = { GOTO: 1, COLOR: 2, PUT: 3, REPEAT: 4, SCROLL: 5, COLORS: 6, CLS: 7, FRAME: 8, SPRITE: 9, NOSPRITE: 10, GLYPH: 11, UNDERLINE: 12, BITS: 13, VIEW: 14, POKE: 15, SOUND: 16, PROBE: 17, SPRDEF: 18, SPR: 19, GLIDE: 20, MOVE: 21, SIDW: 22, SIDPLAY: 23, SIDSTOP: 24, SIDRESET: 25, SPRMC: 26 };
export const VIEW = { TERMINAL: 0, LOAD: 1, SHOW: 2 };
// Where SOUND's tables go in the C64 (c64/sound.inc).
export const SOUND_ADDR = { OUTTAB: 0xCD00, DTAB: 0xCE00, NIDX: 0xCE40 };
export const SOUND_WINDOW = 128; // bytes of codes the C64 holds, which the bridge keeps in flight
export const encodeSound = (variant, delay, latch, n) => {
  if (!(n >= 1 && n <= 0xFFFFFF)) throw new Error('a sound is 1 to 16777215 bytes of codes');
  return [OP.SOUND, variant, delay, latch & 0xFF, latch >> 8, n & 0xFF, (n >> 8) & 0xFF, n >> 16];
};
export const encodePoke = (addr, data) => [OP.POKE, addr & 0xFF, addr >> 8, data.length & 0xFF, ...data];
// Game hardware (the C64 text client; game.js): sprites, SID scripts, rectangle moves.
export const SPRITE_SLOTS = 32;
export const SPR = { ON: 2, MULTI: 4, WIDE: 8, TALL: 16, BEHIND: 32 }; // SPR flags above bit 0, which is x's bit 8
export const encodeSprDef = (slot, data) => [OP.SPRDEF, slot, ...Array.from({ length: 63 }, (_, i) => data[i] ?? 0)];
export const encodeSpr = (n, slot, color, flags, x, y) => [OP.SPR, n, slot, color & 15, flags & 0x3E | (x >> 8 & 1), x & 0xFF, y & 0xFF];
export const encodeGlide = (n, frames, dx, dy) => [OP.GLIDE, n, frames, dx & 0xFF, dy & 0xFF];
export const encodeMove = (x, y, w, h, dx, dy) => [OP.MOVE, x, y, w, h, dx & 0xFF, dy & 0xFF];
export const encodeSidW = pairs => [OP.SIDW, pairs.length / 2, ...pairs];
export const encodeSidPlay = (ch, addr, mask) => [OP.SIDPLAY, ch, addr & 0xFF, addr >> 8, mask & 0xFF, mask >> 8 & 0xFF, mask >> 16 & 0xFF, mask >>> 24 & 0xFF];
export const encodeSidStop = ch => [OP.SIDSTOP, ch];
const SPRITES = 8;
const spriteKey = s => s ? `${s.col},${s.row},${s.color},${s.data.join(',')}` : null;
// VDC attribute bits beyond the colour.
export const VDC = { UNDERLINE: 0x20, RVS: 0x40, ALT: 0x80 };
export const MSG = { ACK: 1, KEY: 2, HELLO: 3, HELLO_ON: 4, DONE: 5, CREDIT: 6, PROBE: 7, ABORT: 8, GLIDE: 9 };

const SPACE = 32;
const MAX_GAP = 3; // unchanged cells worth rewriting instead of a 3-byte GOTO
const ATTRS = 0xF0; // colour bits beyond the colour itself (C128 attributes)
export const HIRES_UNDERLINE = 0x100; // hi-res colour bit: sent with UNDERLINE, not COLOR

// Do two cells with glyph g look the same in colours a and b? A space does in
// any colour, unless an attribute such as underline shows on it, or (`hires`)
// in any foreground on the same background.
export const sameLook = (g, a, b, hires = false) => a === b || (g === SPACE &&
  (hires ? a >= 0 && b >= 0 && (a & 0x10F) === (b & 0x10F) : ((a | b) & ATTRS) === 0));

// Commands that change the client's current colour from state.cur to c.
function setColour(out, state, c) {
  const cur = state.cur;
  if (cur < 0 || (cur & 0xFF) !== (c & 0xFF)) out.push(OP.COLOR, c & 0xFF);
  if (state.hires && (cur < 0 || (cur & HIRES_UNDERLINE) !== (c & HIRES_UNDERLINE))) {
    out.push(OP.UNDERLINE, c & HIRES_UNDERLINE ? 1 : 0);
  }
  state.cur = c;
}

// Mirror of what the C64 is displaying, plus its write pointer and colour.
export class ScreenState {
  constructor(cols = COLS, rows = ROWS, hires = false) {
    this.cols = cols;
    this.rows = rows;
    this.hires = hires;
    this.glyph = new Int32Array(cols * rows).fill(-1); // -1 = unknown
    this.color = new Int16Array(cols * rows).fill(-1);
    this.pos = -1;
    this.cur = -1;
    this.sprites = new Array(SPRITES).fill(undefined); // spriteKey; undefined = unknown
  }

  clone() {
    const s = new ScreenState(this.cols, this.rows, this.hires);
    s.glyph.set(this.glyph);
    s.color.set(this.color);
    s.pos = this.pos;
    s.cur = this.cur;
    s.sprites = [...this.sprites];
    return s;
  }

  matches(i, g, c) {
    return this.glyph[i] === g && sameLook(g, this.color[i], c, this.hires);
  }

  // What MOVE does to the C64's screen: the w x h cells at x, y go to x + dx, y + dy.
  move(x, y, w, h, dx, dy) {
    const { cols } = this;
    const g = [], c = [];
    for (let r = 0; r < h; r++) {
      const i = (y + r) * cols + x;
      g.push(this.glyph.slice(i, i + w));
      c.push(this.color.slice(i, i + w));
    }
    for (let r = 0; r < h; r++) {
      const i = (y + r + dy) * cols + x + dx;
      this.glyph.set(g[r], i);
      this.color.set(c[r], i);
    }
  }

  scrollUp(top, bot, n) {
    const cols = this.cols;
    const from = (top + n) * cols, to = (bot + 1) * cols;
    this.glyph.copyWithin(top * cols, from, to);
    this.color.copyWithin(top * cols, from, to);
    const clear = Math.max(top, bot - n + 1) * cols;
    this.glyph.fill(SPACE, clear, to);
    this.color.fill(this.cur, clear, to);
  }
}

// Encode the changes that take `state` to `want` ({glyph, color} arrays of the
// same size). Mutates `state` to match what the C64 will show. Stops once
// `out` holds about `budget` bytes, and returns false if that left changes
// for another frame.
function encodeDiff(state, want, out, budget = Infinity) {
  const { glyph: wg, color: wc } = want;
  const { cols } = state, cells = state.glyph.length;
  let i = 0;
  while (i < cells) {
    if (state.matches(i, wg[i], wc[i])) { i++; continue; }
    if (out.length >= budget) return false;

    // Extend the run while changes are no more than MAX_GAP cells apart.
    let last = i;
    for (let j = i + 1; j < cells && j - last <= MAX_GAP; j++) {
      if (!state.matches(j, wg[j], wc[j])) last = j;
    }

    if (state.pos !== i) {
      out.push(OP.GOTO, Math.floor(i / cols), i % cols);
    }

    // Split into segments of one colour; spaces take whatever colour is
    // current. Image cells go in their own segments, with their colours.
    let seg = [], pix = [];
    const flush = () => {
      for (let k = 0; k < seg.length; k += 255) {
        const part = seg.slice(k, k + 255);
        if (part.length >= 4 && part.every(g => g === part[0])) out.push(OP.REPEAT, part.length, part[0]);
        else out.push(OP.PUT, part.length, ...part);
      }
      seg = [];
      if (pix.length) out.push(OP.BITS, pix.length, ...pix.flatMap(g => [...imageCell(g - IMAGE)]));
      pix = [];
    };
    for (let k = i; k <= last; k++) {
      // Out of budget: the rest of the run waits for the next frame.
      if (k > i && out.length + seg.length + pix.length * 9 >= budget) { last = k - 1; break; }
      const g = wg[k];
      if (g >= IMAGE) {
        if (seg.length || pix.length === 255) flush();
        pix.push(g);
        state.glyph[k] = g;
        state.color[k] = wc[k];
        continue;
      }
      if (pix.length) flush();
      if (!sameLook(g, wc[k], state.cur, state.hires)) {
        flush();
        setColour(out, state, wc[k]);
      }
      seg.push(g);
      state.glyph[k] = g;
      state.color[k] = state.cur;
    }
    flush();
    state.pos = last + 1 === cells ? 0 : last + 1; // C64 wraps the pointer
    i = last + 1;
  }
  return true;
}

// Build one frame. Tries every full-screen scroll amount and keeps the
// cheapest encoding. Returns {bytes, state, partial} without touching the
// input state. A frame that would be longer than `budget` bytes (an image)
// stops short of it, and is `partial`: the next frame goes on from there.
export function encodeFrame(state, want, budget = Infinity) {
  const { rows } = state;
  if (want.glyph.length !== state.glyph.length) throw new Error('frame size differs from screen state');
  let best = null;
  for (let n = 0; n < rows; n++) {
    // Only bother scrolling when the top row lines up with an old row.
    if (n > 0 && !rowMatches(state, want, n, 0)) continue;
    const frame = encodeScrolled(state, want, n);
    if (!best || frame.bytes.length < best.bytes.length) best = frame;
  }
  if (want.move && !best.partial) best = bestMove(state, want, best);
  if (best.bytes.length > budget) best = encodeScrolled(state, want, best.n, budget);
  if (want.sprites) encodeSprites(best.state, want.sprites, best.bytes);
  best.bytes.push(OP.FRAME);
  return best;
}

// A rectangle of cells that moved by a few cells (a game's map, as the camera
// follows the player) is cheaper to say with MOVE than to draw again. Looks
// for the shifts (dx, dy) under which cells of the new screen match the old
// ones where they didn't without, takes the rectangle they fill, and keeps
// the frame if it comes out shorter than `best`.
const MOVE_MAX = 3, MOVE_MIN_GAIN = 24, MOVE_MIN_CHANGES = 40;
function bestMove(state, want, best) {
  const { cols, rows } = state;
  const cells = cols * rows;
  let changed = 0;
  for (let i = 0; i < cells; i++) if (!state.matches(i, want.glyph[i], want.color[i])) changed++;
  if (changed < MOVE_MIN_CHANGES) return best;
  for (let dy = -MOVE_MAX; dy <= MOVE_MAX; dy++) {
    for (let dx = -MOVE_MAX; dx <= MOVE_MAX; dx++) {
      if (!dx && !dy) continue;
      const rect = moveRect(state, want, dx, dy);
      if (!rect) continue;
      const s = state.clone();
      const out = [...encodeMove(rect.x, rect.y, rect.w, rect.h, dx, dy)];
      s.move(rect.x, rect.y, rect.w, rect.h, dx, dy);
      const partial = !encodeDiff(s, want, out);
      if (!partial && out.length < best.bytes.length) best = { bytes: out, state: s, n: 0, partial };
    }
  }
  return best;
}

// The source rectangle for shift (dx, dy): cells that match the old screen
// only when shifted, in rows and columns with at least 3 such cells (so a
// stray match elsewhere doesn't widen it), all of which fit the screen both
// before and after. Null if there are too few.
function moveRect(state, want, dx, dy) {
  const { cols, rows } = state;
  const rowN = new Int16Array(rows), colN = new Int16Array(cols);
  let gain = 0;
  for (let y = 0; y < rows; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= rows) continue;
    for (let x = 0; x < cols; x++) {
      const sx = x - dx;
      if (sx < 0 || sx >= cols) continue;
      const i = y * cols + x;
      if (state.matches(i, want.glyph[i], want.color[i])) continue;
      if (!state.matches(sy * cols + sx, want.glyph[i], want.color[i])) continue;
      rowN[y]++; colN[x]++; gain++;
    }
  }
  if (gain < MOVE_MIN_GAIN) return null;
  const span = (n, len) => {
    let best = null, from = -1;
    for (let k = 0; k <= len; k++) {
      if (k < len && n[k] >= 3) { if (from < 0) from = k; continue; }
      if (from >= 0 && (!best || k - from > best[1] - best[0])) best = [from, k];
      from = -1;
    }
    return best;
  };
  const ry = span(rowN, rows), rx = span(colN, cols);
  if (!ry || !rx) return null;
  // Destination x0..x1, y0..y1 (end exclusive); the source is shifted back.
  const x0 = Math.max(rx[0], dx), x1 = Math.min(rx[1], cols + dx);
  const y0 = Math.max(ry[0], dy), y1 = Math.min(ry[1], rows + dy);
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  return { x: x0 - dx, y: y0 - dy, w: x1 - x0, h: y1 - y0 };
}

// The frame that scrolls by `n` rows, then draws what changed.
function encodeScrolled(state, want, n, budget) {
  const { rows } = state;
  const s = state.clone();
  const out = [];
  if (n > 0) {
    // A scroll clears with spaces, never underlined.
    if (s.cur < 0 || s.cur & HIRES_UNDERLINE) setColour(out, s, s.cur < 0 ? 15 : s.cur & 0xFF);
    out.push(OP.SCROLL, 0, rows - 1, n);
    s.scrollUp(0, rows - 1, n);
  }
  const partial = !encodeDiff(s, want, out, budget);
  return { bytes: out, state: s, n, partial };
}

// Sprites whose position, colour or pixels changed, after the cells so a
// scroll and the sprites that follow it land in the same frame.
function encodeSprites(state, sprites, out) {
  for (let n = 0; n < SPRITES; n++) {
    const s = sprites[n] ?? null;
    const key = spriteKey(s);
    if (state.sprites[n] === key) continue;
    if (s) out.push(OP.SPRITE, n, s.col, s.row, s.color, ...s.data);
    else out.push(OP.NOSPRITE, n);
    state.sprites[n] = key;
  }
}

function rowMatches(state, want, fromRow, toRow) {
  const { cols } = state;
  for (let c = 0; c < cols; c++) {
    const i = fromRow * cols + c, j = toRow * cols + c;
    if (!state.matches(i, want.glyph[j], want.color[j])) return false;
  }
  return true;
}

// Full reset: colours, clear screen, then everything that isn't a space.
// `want` may carry {cols, rows, hires}; otherwise it is a C64 screen.
export function encodeReset(want, border = 0, bg = 0, color = 15, budget = Infinity) {
  const state = new ScreenState(want.cols ?? COLS, want.rows ?? ROWS, want.hires);
  const out = [OP.COLORS, border, bg];
  setColour(out, state, color);
  out.push(OP.CLS);
  state.glyph.fill(SPACE);
  state.color.fill(color);
  state.pos = 0;
  state.cur = color;
  const frame = encodeFrame(state, want, budget);
  return { bytes: out.concat(frame.bytes), state: frame.state, partial: frame.partial };
}

// Where the C64 hi-res client keeps a picture shown with VIEW: the bitmap
// and colours of its terminal screen, and the VIC's colour RAM.
const PICTURE = { bitmap: 0x6000, screen: 0x5C00, colram: 0xD800 };

// Frames of at most about `budget` bytes that show a Koala Painter picture
// ({bitmap, screen, colram, bg}, see image.js) full screen on the C64 hi-res
// client: blank the screen, load it, show it. The terminal comes back with
// VIEW TERMINAL and a reset.
export function encodePicture(pic, budget = Infinity) {
  const cmds = [[OP.VIEW, VIEW.LOAD, pic.bg]];
  for (const part of ['bitmap', 'screen', 'colram']) {
    const data = pic[part];
    for (let k = 0; k < data.length; k += 256) {
      const addr = PICTURE[part] + k, chunk = data.subarray(k, k + 256);
      cmds.push([OP.POKE, addr & 0xFF, addr >> 8, chunk.length & 0xFF, ...chunk]);
    }
  }
  cmds.push([OP.VIEW, VIEW.SHOW, pic.bg]);
  const frames = [[]];
  for (const cmd of cmds) {
    if (frames.at(-1).length && frames.at(-1).length + cmd.length > budget) frames.push([]);
    frames.at(-1).push(...cmd);
  }
  for (const f of frames) f.push(OP.FRAME);
  return frames;
}

// Reference implementation of the C64 decoder, used by tests and preview.
export class Decoder {
  constructor(cols = COLS, rows = ROWS) {
    this.cols = cols;
    this.rows = rows;
    this.glyph = new Uint8Array(cols * rows).fill(SPACE);
    this.color = new Uint16Array(cols * rows);
    this.pos = 0;
    this.cur = 0;
    this.border = 0;
    this.bg = 0;
    this.frames = 0;
    this.sprites = new Array(SPRITES).fill(null);
    this.glyphs = new Map(); // GLYPH definitions: code -> 8 bytes
    this.bits = new Array(cols * rows).fill(null); // cells drawn by BITS: 8 bytes
    this.view = VIEW.TERMINAL;
    this.mem = new Uint8Array(0x10000); // what POKE wrote
    this.sounds = []; // SOUND commands (their data bytes are not decoded)
    this.shapes = new Map(); // SPRDEF: slot -> 63 bytes
    this.hw = new Array(SPRITES).fill(null); // SPR: {slot, x, y, color, flags}, and a glide
    this.sprmc = [0, 0];
    this.sid = []; // SIDW, SIDPLAY, SIDSTOP and SIDRESET, as { op, ... }
  }

  put(g, bits = null, color = this.cur) {
    this.glyph[this.pos] = g;
    this.color[this.pos] = color;
    this.bits[this.pos] = bits;
    this.pos = (this.pos + 1) % this.glyph.length;
  }

  feed(bytes) {
    const { cols } = this;
    let i = 0;
    const next = () => bytes[i++];
    while (i < bytes.length) {
      switch (next()) {
        case OP.GOTO: { const r = next(), c = next(); this.pos = r * cols + c; break; }
        case OP.COLOR: this.cur = (this.cur & HIRES_UNDERLINE) | next(); break; // the C64 masks it to 0-15
        case OP.UNDERLINE: this.cur = (this.cur & 0xFF) | (next() ? HIRES_UNDERLINE : 0); break;
        case OP.PUT: { const n = next(); for (let k = 0; k < n; k++) this.put(next()); break; }
        case OP.REPEAT: { const n = next(), g = next(); for (let k = 0; k < n; k++) this.put(g); break; }
        case OP.SCROLL: {
          const top = next(), bot = next(), n = next();
          const from = (top + n) * cols, to = (bot + 1) * cols;
          this.glyph.copyWithin(top * cols, from, to);
          this.color.copyWithin(top * cols, from, to);
          this.bits.copyWithin(top * cols, from, to);
          const clear = Math.max(top, bot - n + 1) * cols;
          this.glyph.fill(SPACE, clear, to);
          this.color.fill(this.cur, clear, to);
          this.bits.fill(null, clear, to);
          break;
        }
        case OP.COLORS: this.border = next(); this.bg = next(); break;
        case OP.CLS: this.glyph.fill(SPACE); this.color.fill(this.cur); this.bits.fill(null); this.pos = 0; break;
        case OP.FRAME: this.frames++; break;
        case OP.SPRITE: {
          const n = next(), col = next(), row = next(), color = next();
          this.sprites[n] = { col, row, color, data: Uint8Array.from({ length: 63 }, next) };
          break;
        }
        case OP.NOSPRITE: this.sprites[next()] = null; break;
        case OP.GLYPH: { const code = next() | next() << 8; this.glyphs.set(code, Uint8Array.from({ length: 8 }, next)); break; }
        case OP.VIEW: this.view = next(); if (this.view === VIEW.LOAD) this.border = this.bg = next(); else next(); break;
        case OP.SOUND: this.sounds.push({ variant: next(), delay: next(), latch: next() | next() << 8, n: next() | next() << 8 | next() << 16 }); break;
        case OP.PROBE: break;
        case OP.SPRDEF: { const slot = next(); this.shapes.set(slot, Uint8Array.from({ length: 63 }, next)); break; }
        case OP.SPR: {
          const n = next(), slot = next(), color = next(), flags = next(), xlo = next(), y = next();
          this.hw[n] = { slot, color, flags: flags & 0x3E, x: xlo | (flags & 1) << 8, y, glide: null };
          break;
        }
        case OP.GLIDE: {
          const n = next(), frames = next(), dx = next() << 24 >> 24, dy = next() << 24 >> 24;
          if (this.hw[n]) this.hw[n].glide = { frames, dx, dy };
          break;
        }
        case OP.MOVE: {
          const x = next(), y = next(), w = next(), h = next(), dx = next() << 24 >> 24, dy = next() << 24 >> 24;
          const g = [], c = [];
          for (let r = 0; r < h; r++) { g.push(this.glyph.slice((y + r) * cols + x, (y + r) * cols + x + w)); c.push(this.color.slice((y + r) * cols + x, (y + r) * cols + x + w)); }
          for (let r = 0; r < h; r++) { this.glyph.set(g[r], (y + r + dy) * cols + x + dx); this.color.set(c[r], (y + r + dy) * cols + x + dx); }
          break;
        }
        case OP.SIDW: { const n = next(); const w = []; for (let k = 0; k < n; k++) w.push([next(), next()]); this.sid.push({ op: 'w', w }); break; }
        case OP.SIDPLAY: { const ch = next(), addr = next() | next() << 8; this.sid.push({ op: 'play', ch, addr, mask: (next() | next() << 8 | next() << 16 | next() << 24) >>> 0 }); break; }
        case OP.SIDSTOP: this.sid.push({ op: 'stop', ch: next() }); break;
        case OP.SIDRESET: this.sid.push({ op: 'reset' }); break;
        case OP.SPRMC: this.sprmc = [next(), next()]; break;
        case OP.POKE: {
          let addr = next() | next() << 8;
          const n = next() || 256;
          for (let k = 0; k < n; k++) this.mem[addr++ & 0xFFFF] = next();
          break;
        }
        case OP.BITS: {
          const n = next();
          for (let k = 0; k < n; k++) {
            const bits = Uint8Array.from({ length: 8 }, next);
            this.put(SPACE, bits, next());
          }
          break;
        }
        default: throw new Error(`bad opcode at ${i - 1}`);
      }
    }
  }
}
