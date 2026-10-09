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

// (Shared by all sessions: a key is reused only after 65536 cells, far more than a screen and its
// scrollback hold, so one session's images outlast the others' traffic in practice.)
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

// Pictures from the program are untrusted: a few KB of PNG can claim gigabytes of pixels.
const MAX_PIXELS = 4096 * 4096;

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
  if (width * height > MAX_PIXELS) throw new Error(`PNG too big (${width}x${height}): at most ${MAX_PIXELS} pixels`);
  const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * height });
  if (raw.length < (stride + 1) * height) throw new Error('PNG data is short');
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

// --- colour matching ----------------------------------------------------------------
//
// Colours are compared in CIELAB, where distances follow what the eye sees
// better than in RGB. (Scaling the picture's chroma down, to find vivid
// colours' matches by hue, turned blues purple: the VIC's blue is more
// saturated than its purple.) A VIC colour is its own nearest, so the C64's
// own pictures convert pixel for pixel.
//
// Flat art (no more than FLAT_COLOURS colours) isn't dithered: each colour
// maps to one VIC colour across the whole picture, and a cell that needs
// more colours than it can have gives its least-used ones their next best
// match. Anything else, such as a photograph, is ordered-dithered where a
// mix of two colours comes clearly closer than either.

// A colour (0xRRGGBB) as a CIELAB point.
function lab(rgb) {
  const lin = v => (v /= 255) > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
  const [r, g, b] = [rgb >> 16, rgb >> 8 & 255, rgb & 255].map(lin);
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

const PAL_LAB = VIC_RGB.map(lab);
const dist2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
const rgbAt = (rgb, o) => Math.round(rgb[o]) << 16 | Math.round(rgb[o + 1]) << 8 | Math.round(rgb[o + 2]);

const FLAT_COLOURS = 32; // pictures with no more colours than this are flat art
const MERGE_COST = 1; // merging two different colours, against mapping each to a worse match
const MERGE_COLOURS = 64; // past this many (flat forced on a photo), colours just take their nearest

// Dithering: a mix of two colours is scored by its distance from the pixel
// plus a share of its own spread (1 would make a mix never better than a
// flat colour). Multicolour's pixels are twice as wide, so its patterns show
// more, and must do more good.
const MIX_HIRES = 0.25;
const MIX_MULTICOLOUR = 0.5;

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

// `imgcat -t` values that say whether to dither (else: flat art isn't).
const DITHER = { flat: false, dither: true };

// The picture's distinct colours (0xRRGGBB, opaque pixels only), or null if
// there are more than `max`.
function colours(img, max) {
  const seen = new Set();
  for (let o = 0; o < img.rgba.length; o += 4) {
    if (img.rgba[o + 3] < 128) continue;
    seen.add(img.rgba[o] << 16 | img.rgba[o + 1] << 8 | img.rgba[o + 2]);
    if (seen.size > max) return null;
  }
  return [...seen];
}

// The colours of flat art `img` shrunk (or grown) to w x h at (ox, oy) on a
// cw x ch screen: each pixel's index in `list`, the colour most of its area
// has (no blending at the edges). Pixels around the picture, and clear
// ones, are `clear`. `order(x, y)` gives each pixel's place in the result.
function flatPixels(img, list, w, h, cw, ch, ox, oy, order, clear) {
  const index = new Map(list.map((c, i) => [c, i]));
  const px = new Int16Array(cw * ch).fill(clear);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * img.height / h), y1 = Math.max(y0 + 1, Math.floor((y + 1) * img.height / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * img.width / w), x1 = Math.max(x0 + 1, Math.floor((x + 1) * img.width / w));
      const votes = new Map();
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const o = (sy * img.width + sx) * 4;
          const s = img.rgba[o + 3] < 128 ? clear : index.get(img.rgba[o] << 16 | img.rgba[o + 1] << 8 | img.rgba[o + 2]);
          votes.set(s, (votes.get(s) ?? 0) + 1);
        }
      }
      let best = clear, most = 0;
      for (const [s, v] of votes) if (v > most) { most = v; best = s; }
      px[order(x + ox, y + oy)] = best;
    }
  }
  return px;
}

// What each VIC colour c costs for picture colour s, cost[s * 16 + c], with
// one VIC colour for each picture colour chosen for the whole picture at no
// cost: the nearest, unless that merges picture colours that look
// different (the bands of a sunset all finding the same orange), weighed by
// how different they are and how much of the smaller one there is. `px`:
// the picture's pixels (indexes into list; negative: none).
function flatCosts(list, px) {
  const n = list.length;
  const labs = list.map(lab);
  const cost = new Float64Array(n * 16);
  labs.forEach((q, s) => PAL_LAB.forEach((p, c) => { cost[s * 16 + c] = dist2(q, p); }));
  const total = new Float64Array(n);
  for (const s of px) if (s >= 0) total[s]++;
  const assign = list.map((_, s) => [...Array(16).keys()].reduce((a, b) => (cost[s * 16 + b] < cost[s * 16 + a] ? b : a)));
  const merged = (s, c) => {
    let e = 0;
    for (let t = 0; t < n; t++) if (t !== s && assign[t] === c) e += MERGE_COST * Math.min(total[s], total[t]) * dist2(labs[s], labs[t]);
    return e;
  };
  for (let pass = 0, changed = n <= MERGE_COLOURS; changed && pass < 20; pass++) {
    changed = false;
    for (let s = 0; s < n; s++) {
      const score = c => total[s] * cost[s * 16 + c] + merged(s, c);
      let best = assign[s];
      for (let c = 0; c < 16; c++) if (score(c) < score(best)) best = c;
      if (best !== assign[s]) { assign[s] = best; changed = true; }
    }
  }
  assign.forEach((c, s) => { cost[s * 16 + c] = 0; });
  return cost;
}

// Flat art's cells: `fixed` colours (the background, or none) plus `free`
// more for each cell of `size` pixels in `px`, chosen from each colour's
// three best: {err, colours} per cell.
function flatCells(px, cost, cells, size, fixed, free) {
  const n = cost.length / 16;
  const top = Array.from({ length: n }, (_, s) => [...Array(16).keys()].sort((a, b) => cost[s * 16 + a] - cost[s * 16 + b]).slice(0, 3));
  const out = [];
  for (let i = 0; i < cells; i++) {
    const counts = new Map();
    for (let k = i * size; k < (i + 1) * size; k++) if (px[k] >= 0) counts.set(px[k], (counts.get(px[k]) ?? 0) + 1);
    const want = [...new Set([...counts.keys()].flatMap(s => top[s]))].filter(c => !fixed.includes(c));
    for (let c = 0; want.length < free; c++) if (!fixed.includes(c) && !want.includes(c)) want.push(c);
    let best = { err: Infinity };
    for (const pick of choose(want, free)) {
      const set = [...fixed, ...pick];
      let err = 0;
      for (const [s, count] of counts) {
        let min = Infinity;
        for (const c of set) min = Math.min(min, cost[s * 16 + c]);
        err += count * min;
      }
      if (err < best.err) best = { err, colours: set };
    }
    out.push(best);
  }
  return out;
}

// Every way to choose k of `items`, in order.
function* choose(items, k, from = 0) {
  if (!k) { yield []; return; }
  for (let i = from; i <= items.length - k; i++) for (const rest of choose(items, k - 1, i + 1)) yield [items[i], ...rest];
}

// The place in `set` of flat art pixel s's best colour.
function nearestIn(cost, s, set) {
  let best = 0;
  for (let j = 1; j < set.length; j++) if (cost[s * 16 + set[j]] < cost[s * 16 + set[best]]) best = j;
  return best;
}

// How far point p[k..k+2] is from the dithered mixes of VIC colours i and j,
// scoring a mix `spread` times its own spread, and where on the way it is
// (t: 0 = i, 1 = j).
function mix(p, k, i, j, spread) {
  const [ar, ag, ab] = PAL_LAB[i];
  const dr = PAL_LAB[j][0] - ar, dg = PAL_LAB[j][1] - ag, db = PAL_LAB[j][2] - ab;
  const len = dr * dr + dg * dg + db * db;
  const pr = p[k] - ar, pg = p[k + 1] - ag, pb = p[k + 2] - ab;
  let t = len ? (pr * dr + pg * dg + pb * db) / len : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const er = pr - t * dr, eg = pg - t * dg, eb = pb - t * db;
  return { err: er * er + eg * eg + eb * eb + spread * t * (1 - t) * len, t };
}

// --- hi-res conversion ------------------------------------------------------------

// Pixel (x, y) of a hi-res picture `cols` cells wide, cell by cell: cell i
// holds pixels i * 64 ...
const hiresOrder = cols => (x, y) => ((y >> 3) * cols + (x >> 3)) * 64 + (y & 7) * 8 + (x & 7);

// A hi-res cell: 8 bitmap bytes (bit set: colours[1]), then colours[1] << 4 |
// colours[0], from `slot(k)`, each pixel's 0 or 1.
function hiresCell(colours, slot) {
  const out = new Uint8Array(CELL_BYTES);
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) byte = byte << 1 | slot(y * 8 + x);
    out[y] = byte;
  }
  out[8] = colours[1] << 4 | colours[0];
  return out;
}

// One 8x8 cell of points (64 * 3) as 9 bytes: the pair of colours whose
// dithered mixes come closest, then the pixels ordered-dithered between them.
function ditheredCell(p) {
  let best = Infinity, bi = 0, bj = 0;
  for (let i = 0; i < 16; i++) {
    for (let j = i; j < 16; j++) {
      let err = 0;
      for (let k = 0; k < 192 && err < best; k += 3) err += mix(p, k, i, j, MIX_HIRES).err;
      if (err < best) { best = err; bi = i; bj = j; }
    }
  }
  return hiresCell([bi, bj], k => (mix(p, k * 3, bi, bj, MIX_HIRES).t > BAYER[k] ? 1 : 0));
}

// The image as `cols` x `rows` hi-res cells: {cols, rows, keys}. What's
// left of the cells around it, and clear pixels, are `bg` (0xRRGGBB, a VIC
// colour). args.type: flat or dither (see DITHER), else flat art isn't.
export function toCells(img, args, maxCols, maxRows, bg) {
  const { w, h } = fitSize(img.width, img.height, args, Math.min(maxCols, MAX_COLS), Math.min(maxRows, MAX_ROWS));
  const cols = Math.ceil(w / 8), rows = Math.ceil(h / 8);
  const cw = cols * 8, ch = rows * 8, n = cols * rows;
  const keys = new Uint32Array(n);
  const dither = DITHER[args.type?.toLowerCase()];
  const list = dither ? null : colours(img, dither === false ? Infinity : FLAT_COLOURS);

  if (list) {
    if (!list.includes(bg)) list.push(bg);
    const px = flatPixels(img, list, w, h, cw, ch, 0, 0, hiresOrder(cols), list.indexOf(bg));
    const cost = flatCosts(list, px);
    flatCells(px, cost, n, 64, [], 2).forEach(({ colours: set }, i) => {
      keys[i] = addCell(hiresCell(set, k => nearestIn(cost, px[i * 64 + k], set)));
    });
    return { cols, rows, keys };
  }

  const rgb = resample(img, w, h, cw, ch, bg);
  const p = new Float32Array(192);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) p.set(lab(rgbAt(rgb, ((cy * 8 + y) * cw + cx * 8 + x) * 3)), (y * 8 + x) * 3);
      }
      keys[cy * cols + cx] = addCell(ditheredCell(p));
    }
  }
  return { cols, rows, keys };
}

// --- multicolour conversion ------------------------------------------------------

const CELL_PX = 32; // a multicolour cell: 4 double-width pixels by 8
const CANDIDATES = 7; // colours per cell worth trying in threes (dithering)

// The picture's size in 160x200 double-width pixels, filling as much of
// the screen as it can, and where it goes: {w, h, ox, oy}.
function koalaFit(img) {
  const s = Math.min(320 / img.width, 200 / img.height);
  const w = Math.max(1, Math.min(160, Math.round(img.width * s / 2)));
  const h = Math.max(1, Math.min(200, Math.round(img.height * s)));
  return { w, h, ox: (160 - w) >> 1, oy: (200 - h) >> 1 };
}

// Index of pixel (x, y) of the 160x200 screen, cell by cell: cell i holds
// pixels i * 32 ...
const cellOrder = (x, y) => ((y >> 3) * 40 + (x >> 2)) * CELL_PX + (y & 7) * 4 + (x & 3);

// Koala Painter data from each pixel's slot (0 = background, 1-3 = the
// cell's colours) and each cell's colours [bg, c1, c2, c3].
function encodeKoala(slots, cells, bg) {
  const bitmap = new Uint8Array(8000), screen = new Uint8Array(1000), colram = new Uint8Array(1000);
  for (let i = 0; i < 1000; i++) {
    for (let y = 0; y < 8; y++) {
      let byte = 0;
      for (let x = 0; x < 4; x++) byte = byte << 2 | slots[i * CELL_PX + y * 4 + x];
      bitmap[i * 8 + y] = byte;
    }
    screen[i] = cells[i][1] << 4 | cells[i][2];
    colram[i] = cells[i][3];
  }
  return { bitmap, screen, colram, bg };
}

// Flat art: pixels around the picture, and clear ones, are the background,
// which is whichever VIC colour does best.
function flatKoala(img, list) {
  const { w, h, ox, oy } = koalaFit(img);
  const px = flatPixels(img, list, w, h, 160, 200, ox, oy, cellOrder, -1);
  const cost = flatCosts(list, px);
  let pick = null;
  for (let bg = 0; bg < 16; bg++) {
    const cells = flatCells(px, cost, 1000, CELL_PX, [bg], 3);
    const err = cells.reduce((e, c) => e + c.err, 0);
    if (!pick || err < pick.err) pick = { err, bg, cells: cells.map(c => c.colours) };
  }
  const slots = px.map((s, k) => (s < 0 ? 0 : nearestIn(cost, s, pick.cells[Math.floor(k / CELL_PX)])));
  return encodeKoala(slots, pick.cells, pick.bg);
}

// The closest mix of two of `set` for pixel k: {err, t, i, j} (indexes into set).
function bestMix(p, k, set) {
  let best = { err: Infinity };
  for (let i = 0; i < set.length; i++) {
    for (let j = i + 1; j < set.length; j++) {
      const m = mix(p, k, set[i], set[j], MIX_MULTICOLOUR);
      if (m.err < best.err) best = { ...m, i, j };
    }
  }
  return best;
}

// The colours worth trying in a cell (the two nearest to each pixel, most
// often first), other than the background.
function candidates(p, base, bg) {
  const count = new Array(16).fill(0);
  for (let k = base; k < base + CELL_PX * 3; k += 3) {
    const d = PAL_LAB.map(q => (p[k] - q[0]) ** 2 + (p[k + 1] - q[1]) ** 2 + (p[k + 2] - q[2]) ** 2);
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
  for (const three of choose(cand, 3)) {
    const colours = [bg, ...three];
    let err = 0;
    for (let k = base; k < base + CELL_PX * 3 && err < best.err; k += 3) err += bestMix(p, k, colours).err;
    if (err < best.err) best = { err, colours };
  }
  return best;
}

// Photographs: the background is the best of the colours most pixels are
// nearest to; then each cell takes the three colours whose dithered mixes
// come closest, ordered-dithered.
function ditheredKoala(img) {
  const { w, h, ox, oy } = koalaFit(img);
  const rgb = resample(img, w, h, 160, 200, 0, ox, oy);

  // Pixels as points, cell by cell. Pixels around the picture are the
  // background colour, whichever it is.
  const p = new Float32Array(160 * 200 * 3);
  const around = [];
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x < 160; x++) {
      const k = cellOrder(x, y) * 3;
      p.set(lab(rgbAt(rgb, (y * 160 + x) * 3)), k);
      if (x < ox || x >= ox + w || y < oy || y >= oy + h) around.push(k);
    }
  }
  const surround = bg => { for (const k of around) p.set(PAL_LAB[bg], k); };

  const nearest = new Array(16).fill(0);
  const outside = new Set(around);
  for (let k = 0; k < p.length; k += 3) {
    if (outside.has(k)) continue;
    let best = 0, bd = Infinity;
    PAL_LAB.forEach((q, c) => {
      const d = (p[k] - q[0]) ** 2 + (p[k + 1] - q[1]) ** 2 + (p[k + 2] - q[2]) ** 2;
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
  const slots = new Uint8Array(160 * 200);
  for (let i = 0; i < 1000; i++) {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 4; x++) {
        const k = i * CELL_PX + y * 4 + x;
        const m = bestMix(p, k * 3, pick.cells[i]);
        slots[k] = m.t > BAYER[y * 8 + ((i % 40) * 4 + x & 7)] ? m.j : m.i;
      }
    }
  }
  return encodeKoala(slots, pick.cells, pick.bg);
}

// A picture as Koala Painter data ({bitmap, screen, colram, bg}, see
// koala()), filling as much of the screen as it can: 160x200 pixels, each
// twice as wide as it is tall, in four colours per 4x8 cell, one of them the
// background of the whole picture. `dither`: true or false, or undefined to
// dither only pictures with more than FLAT_COLOURS colours.
export function toKoala(img, dither) {
  const list = dither ? null : colours(img, dither === false ? Infinity : FLAT_COLOURS);
  return list ? flatKoala(img, list) : ditheredKoala(img);
}

// The types (imgcat -t) that ask for a picture in multicolour, full screen,
// and after a colon, how: flat (no dithering) or dither.
const MULTICOLOUR = new Set(['koala', 'multicolour', 'multicolor']);

// What to show full screen in multicolour, instead of in the terminal: a
// Koala picture, or any picture sent with -t koala (or multicolour, either
// with :flat or :dither). Koala Painter data (see koala()), or null.
export function multicolourPicture(file, args = {}) {
  const pic = koala(file);
  if (pic) return pic;
  const [kind, how] = (args.type ?? '').toLowerCase().split(':');
  return MULTICOLOUR.has(kind) ? toKoala(decodeImage(file), DITHER[how]) : null;
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
