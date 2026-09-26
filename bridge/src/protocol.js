// Wire protocol between the bridge and the C64 client.
//
// Host -> C64 (the C64 keeps a write pointer and a current colour):
//   01 row col         GOTO     move write pointer
//   02 color           COLOR    set current colour (0-15)
//   03 n g1..gn        PUT      write n screen codes, advancing
//   04 n g             REPEAT   write screen code g n times
//   05 top bot n       SCROLL   scroll rows top..bot up by n, clear with spaces
//   06 border bg       COLORS   set $D020/$D021
//   07                 CLS      clear screen with spaces, pointer to 0,0
//   08                 FRAME    end of frame; C64 answers ACK
//
// C64 -> host:
//   01                 ACK      frame processed
//   02 key mods        KEY      matrix code 0-63, mods bit0 shift, bit1 C=, bit2 ctrl
//   03                 HELLO    client (re)started; host sends a full redraw

export const COLS = 40;
export const ROWS = 25;
export const CELLS = COLS * ROWS;

export const OP = { GOTO: 1, COLOR: 2, PUT: 3, REPEAT: 4, SCROLL: 5, COLORS: 6, CLS: 7, FRAME: 8 };
export const MSG = { ACK: 1, KEY: 2, HELLO: 3 };

const SPACE = 32;
const MAX_GAP = 3; // unchanged cells worth rewriting instead of a 3-byte GOTO

// Mirror of what the C64 is displaying, plus its write pointer and colour.
export class ScreenState {
  constructor() {
    this.glyph = new Int16Array(CELLS).fill(-1); // -1 = unknown
    this.color = new Int16Array(CELLS).fill(-1);
    this.pos = -1;
    this.cur = -1;
  }

  clone() {
    const s = new ScreenState();
    s.glyph.set(this.glyph);
    s.color.set(this.color);
    s.pos = this.pos;
    s.cur = this.cur;
    return s;
  }

  // Same visible result? A space looks identical in any colour.
  matches(i, g, c) {
    return this.glyph[i] === g && (g === SPACE || this.color[i] === c);
  }

  scrollUp(top, bot, n) {
    const from = (top + n) * COLS, to = (bot + 1) * COLS;
    this.glyph.copyWithin(top * COLS, from, to);
    this.color.copyWithin(top * COLS, from, to);
    const clear = Math.max(top, bot - n + 1) * COLS;
    this.glyph.fill(SPACE, clear, to);
    this.color.fill(this.cur, clear, to);
  }
}

// Encode the changes that take `state` to `want` ({glyph, color} arrays).
// Mutates `state` to match what the C64 will show and returns the byte array.
function encodeDiff(state, want, out) {
  const { glyph: wg, color: wc } = want;
  let i = 0;
  while (i < CELLS) {
    if (state.matches(i, wg[i], wc[i])) { i++; continue; }

    // Extend the run while changes are no more than MAX_GAP cells apart.
    let last = i;
    for (let j = i + 1; j < CELLS && j - last <= MAX_GAP; j++) {
      if (!state.matches(j, wg[j], wc[j])) last = j;
    }

    if (state.pos !== i) {
      out.push(OP.GOTO, Math.floor(i / COLS), i % COLS);
    }

    // Split into segments of one colour; spaces take whatever colour is current.
    let seg = [];
    const flush = () => {
      for (let k = 0; k < seg.length; k += 255) {
        const part = seg.slice(k, k + 255);
        if (part.length >= 4 && part.every(g => g === part[0])) out.push(OP.REPEAT, part.length, part[0]);
        else out.push(OP.PUT, part.length, ...part);
      }
      seg = [];
    };
    for (let k = i; k <= last; k++) {
      const g = wg[k];
      if (g !== SPACE && wc[k] !== state.cur) {
        flush();
        out.push(OP.COLOR, wc[k]);
        state.cur = wc[k];
      }
      seg.push(g);
      state.glyph[k] = g;
      state.color[k] = state.cur;
    }
    flush();
    state.pos = last + 1 === CELLS ? 0 : last + 1; // C64 wraps the pointer
    i = last + 1;
  }
}

// Build one frame. Tries every full-screen scroll amount and keeps the
// cheapest encoding. Returns {bytes, state} without touching the input state.
export function encodeFrame(state, want) {
  let best = null;
  for (let n = 0; n < ROWS; n++) {
    // Only bother scrolling when the top row lines up with an old row.
    if (n > 0 && !rowMatches(state, want, n, 0)) continue;
    const s = state.clone();
    const out = [];
    if (n > 0) {
      if (s.cur < 0) { out.push(OP.COLOR, 15); s.cur = 15; }
      out.push(OP.SCROLL, 0, ROWS - 1, n);
      s.scrollUp(0, ROWS - 1, n);
    }
    encodeDiff(s, want, out);
    if (!best || out.length < best.bytes.length) best = { bytes: out, state: s };
  }
  best.bytes.push(OP.FRAME);
  return best;
}

function rowMatches(state, want, fromRow, toRow) {
  for (let c = 0; c < COLS; c++) {
    const i = fromRow * COLS + c, j = toRow * COLS + c;
    if (!state.matches(i, want.glyph[j], want.color[j])) return false;
  }
  return true;
}

// Full reset: colours, clear screen, then everything that isn't a space.
export function encodeReset(want, border = 0, bg = 0, color = 15) {
  const state = new ScreenState();
  const out = [OP.COLORS, border, bg, OP.COLOR, color, OP.CLS];
  state.glyph.fill(SPACE);
  state.color.fill(color);
  state.pos = 0;
  state.cur = color;
  const frame = encodeFrame(state, want);
  return { bytes: out.concat(frame.bytes), state: frame.state };
}

// Reference implementation of the C64 decoder, used by tests and preview.
export class Decoder {
  constructor() {
    this.glyph = new Uint8Array(CELLS).fill(SPACE);
    this.color = new Uint8Array(CELLS);
    this.pos = 0;
    this.cur = 0;
    this.border = 0;
    this.bg = 0;
    this.frames = 0;
  }

  put(g) {
    this.glyph[this.pos] = g;
    this.color[this.pos] = this.cur;
    this.pos = (this.pos + 1) % CELLS;
  }

  feed(bytes) {
    let i = 0;
    const next = () => bytes[i++];
    while (i < bytes.length) {
      switch (next()) {
        case OP.GOTO: { const r = next(), c = next(); this.pos = r * COLS + c; break; }
        case OP.COLOR: this.cur = next() & 15; break;
        case OP.PUT: { const n = next(); for (let k = 0; k < n; k++) this.put(next()); break; }
        case OP.REPEAT: { const n = next(), g = next(); for (let k = 0; k < n; k++) this.put(g); break; }
        case OP.SCROLL: {
          const top = next(), bot = next(), n = next();
          const from = (top + n) * COLS, to = (bot + 1) * COLS;
          this.glyph.copyWithin(top * COLS, from, to);
          this.color.copyWithin(top * COLS, from, to);
          const clear = Math.max(top, bot - n + 1) * COLS;
          this.glyph.fill(SPACE, clear, to);
          this.color.fill(this.cur, clear, to);
          break;
        }
        case OP.COLORS: this.border = next(); this.bg = next(); break;
        case OP.CLS: this.glyph.fill(SPACE); this.color.fill(this.cur); this.pos = 0; break;
        case OP.FRAME: this.frames++; break;
        default: throw new Error(`bad opcode at ${i - 1}`);
      }
    }
  }
}
