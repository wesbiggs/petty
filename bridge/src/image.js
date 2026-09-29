// Inline images on the C64 hi-res screen: iTerm2's OSC 1337 (as sent by
// imgcat, or the fallback bin/imgcat), in PNG or one of the C64's own
// picture formats.
//
// An image is converted once, when it arrives, into hi-res cells (8 bitmap
// bytes and a colour each), and every cell gets a key. The terminal holds a
// placeholder character for each cell, U+100000 + key (private use), so
// xterm scrolls, clears and overwrites images like any other text, and
// snapshot() turns the placeholders it finds into glyphs IMAGE + key, which
// the encoder sends with BITS. Keys are reused round-robin: 65536 of them are
// more than the terminal and its scrollback can hold.

import { inflateSync } from 'node:zlib';
import { VIC_RGB } from './colors.js';

export const IMAGE = 0x10000; // snapshot glyphs from here on are image cells
export const PLACEHOLDER = 0x100000; // image cell `key` in the terminal
const KEYS = 0x10000;
const CELL_BYTES = 9; // 8 bitmap bytes, then foreground << 4 | background

const MAX_COLS = 40; // the hi-res screen
const MAX_ROWS = 25;

// --- the cells of every image in the terminal --------------------------------

const cells = new Uint8Array(KEYS * CELL_BYTES);
let nextKey = 0;

function addCell(bytes) {
  const key = nextKey;
  nextKey = (nextKey + 1) % KEYS;
  cells.set(bytes, key * CELL_BYTES);
  return key;
}

// The 9 bytes BITS sends for image cell `key`.
export const imageCell = key => cells.subarray(key * CELL_BYTES, (key + 1) * CELL_BYTES);

// The image key of terminal character `code`, or -1.
export const imageKey = code => (code >= PLACEHOLDER && code < PLACEHOLDER + KEYS ? code - PLACEHOLDER : -1);

// The colour covering more of image cell `key` (for text screens).
export function imageShade(key) {
  const c = imageCell(key);
  let lit = 0;
  for (let r = 0; r < 8; r++) for (let b = c[r]; b; b &= b - 1) lit++;
  return lit >= 32 ? c[8] >> 4 : c[8] & 15;
}

// --- decoding ------------------------------------------------------------------

// {width, height, rgba} from a PNG (not interlaced).
export function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) throw new Error('not a PNG');
  let width, height, depth, type, interlace, plte = null, trns = null;
  const idat = [];
  for (let pos = 8; pos + 8 <= buf.length;) {
    const len = buf.readUInt32BE(pos);
    const name = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (name === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      [depth, type, , , interlace] = data.subarray(8);
    } else if (name === 'PLTE') plte = data;
    else if (name === 'tRNS') trns = data;
    else if (name === 'IDAT') idat.push(data);
    else if (name === 'IEND') break;
  }
  if (!width || !height) throw new Error('PNG without a size');
  if (interlace) throw new Error('interlaced PNGs are not supported');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!channels) throw new Error(`PNG colour type ${type}`);
  const bits = channels * depth;
  const bpp = Math.max(1, bits >> 3); // bytes to the same channel of the previous pixel
  const stride = Math.ceil(width * bits / 8);
  const raw = inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(stride * height);

  // Undo the filters, one row at a time.
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride, up = dst - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0;
      const b = y ? px[up + x] : 0;
      const c = x >= bpp && y ? px[up + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[dst + x] = v;
    }
  }

  // Sample k of pixel x on row y, at its own depth.
  const sample = (y, x, k) => {
    const row = y * stride;
    if (depth === 8) return px[row + x * channels + k];
    if (depth === 16) return px[row + (x * channels + k) * 2] << 8 | px[row + (x * channels + k) * 2 + 1];
    const bit = x * depth;
    return px[row + (bit >> 3)] >> (8 - depth - (bit & 7)) & ((1 << depth) - 1);
  };
  const max = (1 << depth) - 1;
  const to8 = v => (depth === 16 ? v >> 8 : depth < 8 ? Math.round(v * 255 / max) : v);
  const key = trns && (type === 0 ? trns.readUInt16BE(0) : type === 2 ? trns.readUIntBE(0, 6) : null);

  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0, o = 0; y < height; y++) {
    for (let x = 0; x < width; x++, o += 4) {
      let r, g, b, a = 255;
      if (type === 3) {
        const i = sample(y, x, 0);
        [r, g, b] = plte ? plte.subarray(i * 3, i * 3 + 3) : [0, 0, 0];
        if (trns && i < trns.length) a = trns[i];
      } else if (type === 0 || type === 4) {
        const v = sample(y, x, 0);
        r = g = b = to8(v);
        if (type === 4) a = to8(sample(y, x, 1));
        else if (v === key) a = 0;
      } else {
        const s = [0, 1, 2].map(k => sample(y, x, k));
        [r, g, b] = s.map(to8);
        if (type === 6) a = to8(sample(y, x, 3));
        else if (s[0] * 2 ** 32 + s[1] * 65536 + s[2] === key) a = 0;
      }
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
    }
  }
  return { width, height, rgba };
}

// The C64's own pictures, known by their size (with the 2-byte load address):
// hi-res Doodle! and Art Studio, multicolour Koala Painter. All 320x200.
const C64_FORMATS = [
  { name: 'Doodle', size: 9218, hires: true, bitmap: 1026, screen: 2 },
  { name: 'Art Studio', size: 9009, hires: true, bitmap: 2, screen: 8002 },
  { name: 'Art Studio', size: 9002, hires: true, bitmap: 2, screen: 8002 },
  { name: 'Koala', size: 10003, hires: false, bitmap: 2, screen: 8002, colram: 9002, bg: 10002 },
];

// A Koala Painter picture's parts, as the VIC shows them in multicolour
// bitmap mode: {bitmap, screen, colram, bg}, or null for anything else.
export function koala(buf) {
  const f = C64_FORMATS.find(f => f.size === buf.length);
  if (!f || f.hires) return null;
  return {
    bitmap: buf.subarray(f.bitmap, f.bitmap + 8000),
    screen: buf.subarray(f.screen, f.screen + 1000),
    colram: buf.subarray(f.colram, f.colram + 1000),
    bg: buf[f.bg] & 15,
  };
}

export function decodeC64(buf) {
  const f = C64_FORMATS.find(f => f.size === buf.length);
  if (!f) return null;
  const rgba = new Uint8Array(320 * 200 * 4);
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x < 320; x++) {
      const cell = (y >> 3) * 40 + (x >> 3);
      const byte = buf[f.bitmap + cell * 8 + (y & 7)];
      const scr = buf[f.screen + cell];
      let c;
      if (f.hires) {
        c = byte >> (7 - (x & 7)) & 1 ? scr >> 4 : scr & 15;
      } else {
        const bits = byte >> (6 - (x & 6)) & 3;
        c = [buf[f.bg] & 15, scr >> 4, scr & 15, buf[f.colram + cell] & 15][bits];
      }
      const o = (y * 320 + x) * 4, rgb = VIC_RGB[c];
      rgba[o] = rgb >> 16; rgba[o + 1] = rgb >> 8 & 255; rgba[o + 2] = rgb & 255; rgba[o + 3] = 255;
    }
  }
  return { width: 320, height: 200, rgba, format: f.name };
}

export function decodeImage(buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return decodePNG(buf);
  const c64 = decodeC64(buf);
  if (c64) return c64;
  throw new Error('unsupported image: use PNG, or a Koala, Doodle or Art Studio picture');
}

// --- size ----------------------------------------------------------------------

// An iTerm2 width or height (N cells, Npx, N%, auto) in pixels, or null.
function pixels(spec, cells) {
  if (!spec || spec === 'auto') return null;
  let m;
  if ((m = /^(\d+)px$/.exec(spec))) return Number(m[1]);
  if ((m = /^(\d+)%$/.exec(spec))) return cells * 8 * Number(m[1]) / 100;
  if ((m = /^(\d+)$/.exec(spec))) return Number(m[1]) * 8;
  return null;
}

// The image's size on screen in pixels: its own, unless the arguments say
// otherwise, and shrunk to fit `cols` x `rows` cells.
export function fitSize(width, height, args, cols, rows) {
  const W = pixels(args.width, cols), H = pixels(args.height, rows);
  const keepAspect = args.preserveAspectRatio !== '0';
  let w = width, h = height;
  if (W && H) {
    if (keepAspect) { const s = Math.min(W / width, H / height); w = width * s; h = height * s; } else { w = W; h = H; }
  } else if (W) { w = W; h = height * W / width; } else if (H) { h = H; w = width * H / height; }
  const s = Math.min(1, cols * 8 / w, rows * 8 / h);
  w *= s; h *= s;
  return { w: Math.max(1, Math.round(Math.min(w, cols * 8))), h: Math.max(1, Math.round(Math.min(h, rows * 8))) };
}

// Box-filtered (area average when shrinking, nearest when growing) RGB, with
// transparency over `bg` (0xRRGGBB), on a canvas of `cw` x `ch` pixels,
// `ox`, `oy` from its top left corner.
function resample({ width, height, rgba }, w, h, cw, ch, bg, ox = 0, oy = 0) {
  const out = new Float32Array(cw * ch * 3);
  const bgc = [bg >> 16, bg >> 8 & 255, bg & 255];
  for (let i = 0; i < cw * ch; i++) out.set(bgc, i * 3);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * height / h), y1 = Math.max(y0 + 1, Math.floor((y + 1) * height / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * width / w), x1 = Math.max(x0 + 1, Math.floor((x + 1) * width / w));
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0, o = (sy * width + x0) * 4; sx < x1; sx++, o += 4) {
          const al = rgba[o + 3];
          r += rgba[o] * al; g += rgba[o + 1] * al; b += rgba[o + 2] * al; a += al;
        }
      }
      const n = (y1 - y0) * (x1 - x0) * 255, cover = a / n;
      const o = ((y + oy) * cw + x + ox) * 3;
      out[o] = r / n + bgc[0] * (1 - cover);
      out[o + 1] = g / n + bgc[1] * (1 - cover);
      out[o + 2] = b / n + bgc[2] * (1 - cover);
    }
  }
  return out;
}

// --- hi-res conversion ------------------------------------------------------------

// Distances weighted roughly like the "redmean" match in colors.js.
const WEIGHT = [Math.sqrt(2.5), 2, Math.sqrt(2.5)];
const weighted = rgb => [(rgb >> 16) * WEIGHT[0], (rgb >> 8 & 255) * WEIGHT[1], (rgb & 255) * WEIGHT[2]];
const PAL = VIC_RGB.map(weighted);
const MIX_COST = 0.25; // how much a dithered mix of two colours is worse than a flat colour

// 8x8 ordered dither thresholds, 0-1.
const BAYER = (() => {
  const m = [0];
  for (let n = 1; n < 64; n *= 4) {
    const s = Math.sqrt(n);
    const next = new Array(n * 4);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const v = m[y * s + x] * 4;
        next[y * 2 * s + x] = v; next[y * 2 * s + x + s] = v + 2;
        next[(y + s) * 2 * s + x] = v + 3; next[(y + s) * 2 * s + x + s] = v + 1;
      }
    }
    m.splice(0, m.length, ...next);
  }
  return m.map(v => (v + 0.5) / 64);
})();

// One 8x8 cell of weighted pixels (64 * 3) as 9 bytes: the pair of colours
// whose dithered mixes come closest, then the pixels ordered-dithered
// between them. A picture already in two colours per cell comes out exact.
function convertCell(p) {
  let best = Infinity, bi = 0, bj = 0;
  for (let i = 0; i < 16; i++) {
    const [ar, ag, ab] = PAL[i];
    for (let j = i; j < 16; j++) {
      const dr = PAL[j][0] - ar, dg = PAL[j][1] - ag, db = PAL[j][2] - ab;
      const len = dr * dr + dg * dg + db * db;
      let err = 0;
      for (let k = 0; k < 192 && err < best; k += 3) {
        const pr = p[k] - ar, pg = p[k + 1] - ag, pb = p[k + 2] - ab;
        let t = len ? (pr * dr + pg * dg + pb * db) / len : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const er = pr - t * dr, eg = pg - t * dg, eb = pb - t * db;
        err += er * er + eg * eg + eb * eb + MIX_COST * t * (1 - t) * len;
      }
      if (err < best) { best = err; bi = i; bj = j; }
    }
  }
  const out = new Uint8Array(CELL_BYTES);
  const [ar, ag, ab] = PAL[bi];
  const dr = PAL[bj][0] - ar, dg = PAL[bj][1] - ag, db = PAL[bj][2] - ab;
  const len = dr * dr + dg * dg + db * db;
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) {
      const k = (y * 8 + x) * 3;
      const t = len ? ((p[k] - ar) * dr + (p[k + 1] - ag) * dg + (p[k + 2] - ab) * db) / len : 0;
      byte = byte << 1 | (t > BAYER[y * 8 + x] ? 1 : 0);
    }
    out[y] = byte;
  }
  out[8] = bj << 4 | bi;
  return out;
}

// The image as `cols` x `rows` hi-res cells: {cols, rows, keys}.
export function toCells(img, args, maxCols, maxRows, bg) {
  const { w, h } = fitSize(img.width, img.height, args, Math.min(maxCols, MAX_COLS), Math.min(maxRows, MAX_ROWS));
  const cols = Math.ceil(w / 8), rows = Math.ceil(h / 8);
  const cw = cols * 8;
  const rgb = resample(img, w, h, cw, rows * 8, bg);
  const keys = new Uint32Array(cols * rows);
  const p = new Float32Array(192);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const o = ((cy * 8 + y) * cw + cx * 8 + x) * 3, k = (y * 8 + x) * 3;
          p[k] = rgb[o] * WEIGHT[0]; p[k + 1] = rgb[o + 1] * WEIGHT[1]; p[k + 2] = rgb[o + 2] * WEIGHT[2];
        }
      }
      keys[cy * cols + cx] = addCell(convertCell(p));
    }
  }
  return { cols, rows, keys };
}

// --- multicolour conversion ------------------------------------------------------

// How far weighted pixel p[k..k+2] is from the dithered mixes of colours i
// and j (the same measure as convertCell's), and where on the way it is (t:
// 0 = i, 1 = j).
function mix(p, k, i, j) {
  const [ar, ag, ab] = PAL[i];
  const dr = PAL[j][0] - ar, dg = PAL[j][1] - ag, db = PAL[j][2] - ab;
  const len = dr * dr + dg * dg + db * db;
  const pr = p[k] - ar, pg = p[k + 1] - ag, pb = p[k + 2] - ab;
  let t = len ? (pr * dr + pg * dg + pb * db) / len : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const er = pr - t * dr, eg = pg - t * dg, eb = pb - t * db;
  return { err: er * er + eg * eg + eb * eb + MIX_COST * t * (1 - t) * len, t };
}

// The closest mix of two of `colours` for pixel k: {err, t, i, j} (indexes
// into colours).
function bestMix(p, k, colours) {
  let best = { err: Infinity };
  for (let i = 0; i < colours.length; i++) {
    for (let j = i + 1; j < colours.length; j++) {
      const m = mix(p, k, colours[i], colours[j]);
      if (m.err < best.err) best = { ...m, i, j };
    }
  }
  return best;
}

const CELL_PX = 32; // a multicolour cell: 4 double-width pixels by 8
const CANDIDATES = 7; // colours per cell worth trying in threes

// The colours worth trying in a cell (the two nearest to each pixel, most
// often first), other than the background.
function candidates(p, base, bg) {
  const count = new Array(16).fill(0);
  for (let k = base; k < base + CELL_PX * 3; k += 3) {
    const d = PAL.map(([r, g, b], c) => ((p[k] - r) ** 2 + (p[k + 1] - g) ** 2 + (p[k + 2] - b) ** 2));
    const order = [...d.keys()].sort((a, b) => d[a] - d[b]);
    count[order[0]] += 2;
    count[order[1]]++;
  }
  const out = [...count.keys()].filter(c => c !== bg && count[c]).sort((a, b) => count[b] - count[a]).slice(0, CANDIDATES);
  for (let c = 0; out.length < 3; c++) if (c !== bg && !out.includes(c)) out.push(c);
  return out;
}

// The best three colours for a cell with background bg: {err, colours}.
function cellColours(p, base, bg) {
  const cand = candidates(p, base, bg);
  let best = { err: Infinity, colours: null };
  for (let a = 0; a < cand.length; a++) {
    for (let b = a + 1; b < cand.length; b++) {
      for (let c = b + 1; c < cand.length; c++) {
        const colours = [bg, cand[a], cand[b], cand[c]];
        let err = 0;
        for (let k = base; k < base + CELL_PX * 3 && err < best.err; k += 3) err += bestMix(p, k, colours).err;
        if (err < best.err) best = { err, colours };
      }
    }
  }
  return best;
}

// A picture as Koala Painter data ({bitmap, screen, colram, bg}, see
// koala()), filling as much of the screen as it can: 160x200 pixels, each
// twice as wide as it is tall, in four colours per 4x8 cell, one of them
// the background of the whole picture. The background is the best of the
// colours most pixels are nearest to; then each cell takes the three
// colours whose dithered mixes come closest, ordered-dithered as on the
// hi-res screen.
export function toKoala(img) {
  const s = Math.min(320 / img.width, 200 / img.height);
  const w = Math.max(1, Math.round(img.width * s / 2)), h = Math.max(1, Math.round(img.height * s));
  const ox = (160 - w) >> 1, oy = (200 - h) >> 1;
  const rgb = resample(img, w, h, 160, 200, 0, ox, oy);

  // Weighted pixels, cell by cell: cell i is p[i * 96 ..]. Pixels around
  // the picture (it doesn't fill the screen) are the background colour.
  const p = new Float32Array(160 * 200 * 3);
  const around = [];
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x < 160; x++) {
      const o = (y * 160 + x) * 3, k = (((y >> 3) * 40 + (x >> 2)) * CELL_PX + (y & 7) * 4 + (x & 3)) * 3;
      for (let c = 0; c < 3; c++) p[k + c] = rgb[o + c] * WEIGHT[c];
      if (x < ox || x >= ox + w || y < oy || y >= oy + h) around.push(k);
    }
  }
  const surround = bg => { for (const k of around) p.set(PAL[bg], k); };

  const nearest = new Array(16).fill(0);
  const outside = new Set(around);
  for (let k = 0; k < p.length; k += 3) {
    if (outside.has(k)) continue;
    let best = 0, bd = Infinity;
    PAL.forEach(([r, g, b], c) => {
      const d = (p[k] - r) ** 2 + (p[k + 1] - g) ** 2 + (p[k + 2] - b) ** 2;
      if (d < bd) { bd = d; best = c; }
    });
    nearest[best]++;
  }
  let pick = null;
  for (const bg of [...nearest.keys()].sort((a, b) => nearest[b] - nearest[a]).slice(0, 3)) {
    const cells = [];
    let err = 0;
    surround(bg);
    for (let i = 0; i < 1000; i++) {
      const c = cellColours(p, i * CELL_PX * 3, bg);
      cells.push(c.colours);
      err += c.err;
    }
    if (!pick || err < pick.err) pick = { err, bg, cells };
  }

  surround(pick.bg);
  const bitmap = new Uint8Array(8000), screen = new Uint8Array(1000), colram = new Uint8Array(1000);
  for (let i = 0; i < 1000; i++) {
    const colours = pick.cells[i], base = i * CELL_PX * 3;
    for (let y = 0; y < 8; y++) {
      let byte = 0;
      for (let x = 0; x < 4; x++) {
        const m = bestMix(p, base + (y * 4 + x) * 3, colours);
        const bits = m.t > BAYER[y * 8 + ((i % 40) * 4 + x & 7)] ? m.j : m.i;
        byte = byte << 2 | bits;
      }
      bitmap[i * 8 + y] = byte;
    }
    screen[i] = colours[1] << 4 | colours[2];
    colram[i] = colours[3];
  }
  return { bitmap, screen, colram, bg: pick.bg };
}

// The types (imgcat -t) that ask for a picture in multicolour, full screen.
const MULTICOLOUR = new Set(['koala', 'multicolour', 'multicolor']);

// What to show full screen in multicolour, instead of in the terminal: a
// Koala picture, or any picture sent with -t koala (or multicolour). Koala
// Painter data (see koala()), or null.
export function multicolourPicture(file, args = {}) {
  return koala(file) ?? (MULTICOLOUR.has(args.type?.toLowerCase()) ? toKoala(decodeImage(file)) : null);
}

// --- the terminal side -------------------------------------------------------------

// Writes into the terminal as if the program had: xterm's parser is in the
// middle of the program's output, so this uses its input handler directly
// (not in the public API) rather than term.write, which would come after the
// rest of the output.
function writer(term) {
  const core = term._core;
  return {
    print(codes) { core._inputHandler.print(Uint32Array.from(codes), 0, codes.length); },
    newline() { core._inputHandler.carriageReturn(); core._inputHandler.lineFeed(); },
    lineFeed() { core._inputHandler.lineFeed(); },
    get x() { return core.buffer.x; },
    set x(v) { core.buffer.x = v; },
  };
}

// Places the image's placeholders at the cursor, like iTerm2: a row of cells
// on each line, scrolling as needed, starting on the next line if it doesn't
// fit on this one. The cursor ends after the last row.
export function placeImage(term, { cols, rows, keys }) {
  const out = writer(term);
  if (out.x + cols > term.cols) out.newline();
  const x = out.x;
  for (let r = 0; r < rows; r++) {
    if (r) out.lineFeed();
    out.x = x;
    out.print(Array.from(keys.subarray(r * cols, (r + 1) * cols), k => PLACEHOLDER + k));
  }
}

export function printText(term, s) {
  writer(term).print([...s].map(ch => ch.codePointAt(0)));
}

// iTerm2's image escapes (OSC 1337, the part after "1337;"): File=args:base64
// in one, or MultipartFile=args, FilePart=base64..., FileEnd. `opts()` gives
// {maxCols, maxRows, bg}, what the client can show. `fullScreen(file, args)`
// may show a file itself, away from the terminal (see multicolourPicture),
// and returns true if it does. Returns false for other OSC 1337 commands.
export class InlineImages {
  constructor(term, opts, log = () => {}, fullScreen = () => false) {
    this.term = term;
    this.opts = opts;
    this.log = log;
    this.fullScreen = fullScreen;
    this.multipart = null;
  }

  osc(data) {
    const colon = data.indexOf(':');
    if (data.startsWith('File=') && colon >= 0) {
      this.#show(parseArgs(data.slice(5, colon)), data.slice(colon + 1));
    } else if (data.startsWith('MultipartFile=')) {
      this.multipart = { args: parseArgs(data.slice(14)), parts: [] };
    } else if (data.startsWith('FilePart=')) {
      this.multipart?.parts.push(data.slice(9));
    } else if (data === 'FileEnd') {
      if (this.multipart) this.#show(this.multipart.args, this.multipart.parts.join(''));
      this.multipart = null;
    } else {
      return false;
    }
    return true;
  }

  #show(args, base64) {
    if (args.inline !== '1') return; // a download: nowhere to put it
    const name = args.name ? Buffer.from(args.name, 'base64').toString() : 'image';
    try {
      const file = Buffer.from(base64, 'base64');
      if (this.fullScreen(file, args)) {
        this.log(`image ${name}: full screen`);
        return;
      }
      const img = decodeImage(file);
      const { maxCols, maxRows, bg } = this.opts();
      const cells = toCells(img, args, maxCols, maxRows, bg);
      placeImage(this.term, cells);
      this.log(`image ${name}${img.format ? ` (${img.format})` : ''}: ${img.width}x${img.height} as ${cells.cols}x${cells.rows} cells`);
    } catch (e) {
      this.log(`image ${name}: ${e.message}`);
      printText(this.term, `[${name}: ${e.message}]`);
    }
  }
}

const parseArgs = s => Object.fromEntries(s.split(';').filter(Boolean).map(kv => {
  const eq = kv.indexOf('=');
  return eq < 0 ? [kv, ''] : [kv.slice(0, eq), kv.slice(eq + 1)];
}));
