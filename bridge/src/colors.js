// Mapping terminal colours onto a 16-colour palette: the C64's VIC-II, or the
// C128 VDC's RGBI (the same 16 colours as ANSI, in a different order).

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

const COLOURED = 48; // max - min channel of an input that must keep a hue
const GREY = 16; // ... and of a palette entry that counts as grey

// Claude Code's pale blue (permission prompts, suggestions) and its spinner
// shimmer. Nearest-colour matching sends these to cyan, but blue reads right.
const CLAUDE_BLUES = [0xb1b9f9, 0xb1c3ff];

// rgb: 16 palette colours as 0xRRGGBB. ansiFg/ansiBg: ANSI 0-15 -> palette
// index. exact: 0xRRGGBB -> palette index, checked before nearest(). The
// background colour of the screen is 0 (black) in both.
// underline: colour bit for underlined cells, 0 if the display has none.
function makePalette({ rgb, ansiFg, ansiBg, exact, defaultFg, boldFg, dimFg, underline = 0 }) {
  const cache = new Map();

  const chroma = c => Math.max(c >> 16, (c >> 8) & 0xff, c & 0xff) - Math.min(c >> 16, (c >> 8) & 0xff, c & 0xff);

  // Nearest palette entry using a "redmean" weighted distance. A clearly
  // coloured input never maps to a grey: pale tints like Claude Code's
  // lavender rgb(177,185,249) are closer to light grey than to any blue.
  function nearest(value, allowBlack) {
    if (exact.has(value)) return exact.get(value);
    const key = value * 2 + (allowBlack ? 1 : 0);
    let best = cache.get(key);
    if (best !== undefined) return best;
    const r = value >> 16, g = (value >> 8) & 0xff, b = value & 0xff;
    const coloured = chroma(value) >= COLOURED;
    let bestD = Infinity;
    for (let i = allowBlack ? 0 : 1; i < 16; i++) {
      const p = rgb[i];
      if (coloured && chroma(p) < GREY) continue;
      const pr = p >> 16, pg = (p >> 8) & 0xff, pb = p & 0xff;
      const rm = (r + pr) / 2;
      const dr = r - pr, dg = g - pg, db = b - pb;
      const d = (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
      if (d < bestD) { bestD = d; best = i; }
    }
    cache.set(key, best);
    return best;
  }

  return {
    rgb, defaultFg, boldFg, dimFg, underline, screenBg: 0,
    // mode: 'palette' (value 0-255) or 'rgb' (value 0xRRGGBB).
    fg(mode, value) {
      if (mode === 'palette' && value < 16) return ansiFg[value];
      return nearest(mode === 'palette' ? xterm256(value) : value, false);
    },
    // Returns null when the background is effectively the black screen.
    bg(mode, value) {
      const c = mode === 'palette' && value < 16
        ? ansiBg[value]
        : nearest(mode === 'palette' ? xterm256(value) : value, true);
      return c === 0 ? null : c;
    },
  };
}

// C64 (Colodore approximation), index = C64 colour number. ANSI colours are
// hand-mapped for readability on a black screen.
export const VIC = makePalette({
  rgb: [
    0x000000, 0xffffff, 0x813338, 0x75cec8, 0x8e3c97, 0x56ac4d, 0x2e2c9b, 0xedf171,
    0x8e5029, 0x553800, 0xc46c71, 0x4a4a4a, 0x7b7b7b, 0xa9ff9f, 0x706deb, 0xb2b2b2,
  ],
  ansiFg: [11, 2, 5, 7, 14, 4, 3, 15, 12, 10, 13, 7, 14, 4, 3, 1],
  ansiBg: [0, 2, 5, 7, 6, 4, 3, 15, 11, 10, 13, 7, 14, 4, 3, 1],
  exact: new Map(CLAUDE_BLUES.map(c => [c, 14])), // light blue
  defaultFg: 15, // light grey
  boldFg: 1, // white
  dimFg: 12, // grey
});

// C128 VDC, index = RGBI attribute bits (R=8, G=4, B=2, I=1). ANSI maps
// exactly, except black and dark blue text, which would be unreadable.
export const RGBI = makePalette({
  rgb: [
    0x000000, 0x555555, 0x0000aa, 0x5555ff, 0x00aa00, 0x55ff55, 0x00aaaa, 0x55ffff,
    0xaa0000, 0xff5555, 0xaa00aa, 0xff55ff, 0xaa5500, 0xffff55, 0xaaaaaa, 0xffffff,
  ],
  ansiFg: [1, 8, 4, 12, 3, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15],
  ansiBg: [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15],
  exact: new Map(CLAUDE_BLUES.map(c => [c, 3])), // light blue
  defaultFg: 14, // light grey
  boldFg: 15, // white
  dimFg: 1, // dark grey
  underline: 0x20,
});
