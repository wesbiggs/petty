// Wire protocol between the bridge and the C64 client.
//
// Host -> C64 (the C64 keeps a write pointer and a current colour):
//   01 row col         GOTO     move write pointer
//   02 color           COLOR    set current colour (C64: 0-15; C128: VDC attribute,
//                               RGBI in bits 0-3, bit 5 underline)
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
//
// C64 -> host:
//   01                 ACK      frame processed
//   02 key mods        KEY      matrix code 0-63, mods bit0 shift, bit1 C=, bit2 ctrl
//   03                 HELLO    C64 client (re)started; host sends a full redraw
//   04 display         HELLO_ON same, from a client on another display (DISPLAY ids)
//
// Rows and columns are those of the client's display: 40x25 on the C64, 80x25
// on the C128's VDC and on the C64's soft 80-column bitmap screen. The write
// pointer wraps at the end of the screen. `pair`: two neighbouring cells share
// one colour (the bridge makes them equal).

export const DISPLAY = {
  C64: { id: 0, name: 'C64', cols: 40, rows: 25 },
  C128: { id: 1, name: 'C128 VDC', cols: 80, rows: 25 },
  C64_80: { id: 2, name: 'C64 soft-80', cols: 80, rows: 25, pair: true },
};
export const displayById = id => Object.values(DISPLAY).find(d => d.id === id);

// C64 defaults, for callers that only deal with one screen size.
export const COLS = DISPLAY.C64.cols;
export const ROWS = DISPLAY.C64.rows;
export const CELLS = COLS * ROWS;

export const OP = { GOTO: 1, COLOR: 2, PUT: 3, REPEAT: 4, SCROLL: 5, COLORS: 6, CLS: 7, FRAME: 8, SPRITE: 9, NOSPRITE: 10 };
const SPRITES = 8;
const spriteKey = s => s ? `${s.col},${s.row},${s.color},${s.data.join(',')}` : null;
export const MSG = { ACK: 1, KEY: 2, HELLO: 3, HELLO_ON: 4 };

const SPACE = 32;
const MAX_GAP = 3; // unchanged cells worth rewriting instead of a 3-byte GOTO
const ATTRS = 0xF0; // colour bits beyond the colour itself (C128 attributes)

// Do two cells with glyph g look the same in colours a and b? A space does in
// any colour, unless an attribute such as underline shows on it.
export const sameLook = (g, a, b) => a === b || (g === SPACE && ((a | b) & ATTRS) === 0);

// Mirror of what the C64 is displaying, plus its write pointer and colour.
export class ScreenState {
  constructor(cols = COLS, rows = ROWS) {
    this.cols = cols;
    this.rows = rows;
    this.glyph = new Int16Array(cols * rows).fill(-1); // -1 = unknown
    this.color = new Int16Array(cols * rows).fill(-1);
    this.pos = -1;
    this.cur = -1;
    this.sprites = new Array(SPRITES).fill(undefined); // spriteKey; undefined = unknown
  }

  clone() {
    const s = new ScreenState(this.cols, this.rows);
    s.glyph.set(this.glyph);
    s.color.set(this.color);
    s.pos = this.pos;
    s.cur = this.cur;
    s.sprites = [...this.sprites];
    return s;
  }

  matches(i, g, c) {
    return this.glyph[i] === g && sameLook(g, this.color[i], c);
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
// same size). Mutates `state` to match what the C64 will show.
function encodeDiff(state, want, out) {
  const { glyph: wg, color: wc } = want;
  const { cols } = state, cells = state.glyph.length;
  let i = 0;
  while (i < cells) {
    if (state.matches(i, wg[i], wc[i])) { i++; continue; }

    // Extend the run while changes are no more than MAX_GAP cells apart.
    let last = i;
    for (let j = i + 1; j < cells && j - last <= MAX_GAP; j++) {
      if (!state.matches(j, wg[j], wc[j])) last = j;
    }

    if (state.pos !== i) {
      out.push(OP.GOTO, Math.floor(i / cols), i % cols);
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
      if (!sameLook(g, wc[k], state.cur)) {
        flush();
        out.push(OP.COLOR, wc[k]);
        state.cur = wc[k];
      }
      seg.push(g);
      state.glyph[k] = g;
      state.color[k] = state.cur;
    }
    flush();
    state.pos = last + 1 === cells ? 0 : last + 1; // C64 wraps the pointer
    i = last + 1;
  }
}

// Build one frame. Tries every full-screen scroll amount and keeps the
// cheapest encoding. Returns {bytes, state} without touching the input state.
export function encodeFrame(state, want) {
  const { rows } = state;
  if (want.glyph.length !== state.glyph.length) throw new Error('frame size differs from screen state');
  let best = null;
  for (let n = 0; n < rows; n++) {
    // Only bother scrolling when the top row lines up with an old row.
    if (n > 0 && !rowMatches(state, want, n, 0)) continue;
    const s = state.clone();
    const out = [];
    if (n > 0) {
      if (s.cur < 0) { out.push(OP.COLOR, 15); s.cur = 15; }
      out.push(OP.SCROLL, 0, rows - 1, n);
      s.scrollUp(0, rows - 1, n);
    }
    encodeDiff(s, want, out);
    if (!best || out.length < best.bytes.length) best = { bytes: out, state: s };
  }
  if (want.sprites) encodeSprites(best.state, want.sprites, best.bytes);
  best.bytes.push(OP.FRAME);
  return best;
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
// `want` may carry {cols, rows}; otherwise it is a C64 screen.
export function encodeReset(want, border = 0, bg = 0, color = 15) {
  const state = new ScreenState(want.cols ?? COLS, want.rows ?? ROWS);
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
  constructor(cols = COLS, rows = ROWS) {
    this.cols = cols;
    this.rows = rows;
    this.glyph = new Uint8Array(cols * rows).fill(SPACE);
    this.color = new Uint8Array(cols * rows);
    this.pos = 0;
    this.cur = 0;
    this.border = 0;
    this.bg = 0;
    this.frames = 0;
    this.sprites = new Array(SPRITES).fill(null);
  }

  put(g) {
    this.glyph[this.pos] = g;
    this.color[this.pos] = this.cur;
    this.pos = (this.pos + 1) % this.glyph.length;
  }

  feed(bytes) {
    const { cols } = this;
    let i = 0;
    const next = () => bytes[i++];
    while (i < bytes.length) {
      switch (next()) {
        case OP.GOTO: { const r = next(), c = next(); this.pos = r * cols + c; break; }
        case OP.COLOR: this.cur = next(); break; // the C64 masks it to 0-15
        case OP.PUT: { const n = next(); for (let k = 0; k < n; k++) this.put(next()); break; }
        case OP.REPEAT: { const n = next(), g = next(); for (let k = 0; k < n; k++) this.put(g); break; }
        case OP.SCROLL: {
          const top = next(), bot = next(), n = next();
          const from = (top + n) * cols, to = (bot + 1) * cols;
          this.glyph.copyWithin(top * cols, from, to);
          this.color.copyWithin(top * cols, from, to);
          const clear = Math.max(top, bot - n + 1) * cols;
          this.glyph.fill(SPACE, clear, to);
          this.color.fill(this.cur, clear, to);
          break;
        }
        case OP.COLORS: this.border = next(); this.bg = next(); break;
        case OP.CLS: this.glyph.fill(SPACE); this.color.fill(this.cur); this.pos = 0; break;
        case OP.FRAME: this.frames++; break;
        case OP.SPRITE: {
          const n = next(), col = next(), row = next(), color = next();
          this.sprites[n] = { col, row, color, data: Uint8Array.from({ length: 63 }, next) };
          break;
        }
        case OP.NOSPRITE: this.sprites[next()] = null; break;
        default: throw new Error(`bad opcode at ${i - 1}`);
      }
    }
  }
}
