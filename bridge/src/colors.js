// Mapping terminal colours onto the 16-colour C64 palette.

// C64 palette (Colodore approximation), index = C64 colour number.
export const C64_RGB = [
  0x000000, 0xffffff, 0x813338, 0x75cec8, 0x8e3c97, 0x56ac4d, 0x2e2c9b, 0xedf171,
  0x8e5029, 0x553800, 0xc46c71, 0x4a4a4a, 0x7b7b7b, 0xa9ff9f, 0x706deb, 0xb2b2b2,
];

export const BLACK = 0;
export const WHITE = 1;
export const GREY = 12;
export const LIGHT_GREY = 15;

export const DEFAULT_FG = LIGHT_GREY;
export const BOLD_FG = WHITE;
export const DIM_FG = GREY;
export const SCREEN_BG = BLACK;

// ANSI 0-15 hand-mapped for readability on a black screen.
const ANSI_FG = [11, 2, 5, 7, 14, 4, 3, 15, 12, 10, 13, 7, 14, 4, 3, 1];
const ANSI_BG = [0, 2, 5, 7, 6, 4, 3, 15, 11, 10, 13, 7, 14, 4, 3, 1];

// xterm 256-colour palette entry -> 0xRRGGBB (only 16-255 used here).
function xterm256(i) {
  if (i < 232) {
    const v = [0, 95, 135, 175, 215, 255];
    i -= 16;
    return (v[Math.floor(i / 36)] << 16) | (v[Math.floor(i / 6) % 6] << 8) | v[i % 6];
  }
  const g = 8 + (i - 232) * 10;
  return (g << 16) | (g << 8) | g;
}

const nearestCache = new Map();

// Nearest palette entry using a "redmean" weighted distance.
function nearest(rgb, allowBlack) {
  const key = rgb * 2 + (allowBlack ? 1 : 0);
  let best = nearestCache.get(key);
  if (best !== undefined) return best;
  const r = rgb >> 16, g = (rgb >> 8) & 0xff, b = rgb & 0xff;
  let bestD = Infinity;
  for (let i = allowBlack ? 0 : 1; i < 16; i++) {
    const p = C64_RGB[i];
    const pr = p >> 16, pg = (p >> 8) & 0xff, pb = p & 0xff;
    const rm = (r + pr) / 2;
    const dr = r - pr, dg = g - pg, db = b - pb;
    const d = (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
    if (d < bestD) { bestD = d; best = i; }
  }
  nearestCache.set(key, best);
  return best;
}

// mode: 'palette' (value 0-255) or 'rgb' (value 0xRRGGBB).
export function fgColor(mode, value) {
  if (mode === 'palette' && value < 16) return ANSI_FG[value];
  return nearest(mode === 'palette' ? xterm256(value) : value, false);
}

// Returns null when the background is effectively the black screen.
export function bgColor(mode, value) {
  const c = mode === 'palette' && value < 16
    ? ANSI_BG[value]
    : nearest(mode === 'palette' ? xterm256(value) : value, true);
  return c === SCREEN_BG ? null : c;
}
