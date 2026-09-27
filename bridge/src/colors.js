// Mapping terminal colours onto a 16-colour palette: the C64's VIC-II, or the
// C128 VDC's RGBI (the same 16 colours as ANSI, in a different order), in one
// of several themes. A theme sets the screen colour and what the program's
// "default" colours are; programs can ask for them (OSC 10/11/4).

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
const ALL = [...Array(16).keys()];

const chroma = c => Math.max(c >> 16, (c >> 8) & 0xff, c & 0xff) - Math.min(c >> 16, (c >> 8) & 0xff, c & 0xff);
const luma = c => (0.299 * (c >> 16) + 0.587 * ((c >> 8) & 0xff) + 0.114 * (c & 0xff)) / 255;

// Claude Code's pale blue (permission prompts, suggestions) and its spinner
// shimmer. Nearest-colour matching sends these to cyan, but blue reads right.
const CLAUDE_BLUES = [0xb1b9f9, 0xb1c3ff];

// rgb: 16 palette colours as 0xRRGGBB. ansiFg/ansiBg: ANSI 0-15 -> palette
// index. exact: 0xRRGGBB -> palette index, checked before the nearest match.
// fgSet/bgSet: palette entries other colours may map to (readable ones).
// screen/border: the screen colour (a background of that colour is none).
// ramp: [[maxLuma, index], ...] turns every colour into a shade of one hue.
// underline: colour bit for underlined cells, 0 if the display has none.
function makePalette({
  rgb, ansiFg, ansiBg, exact, defaultFg, boldFg, dimFg, screen = 0, border = screen,
  fgSet = ALL, bgSet = ALL, ramp = null, underline = 0,
}) {
  const cache = new Map();
  const shade = i => ramp ? ramp.find(([max]) => luma(rgb[i]) <= max)[1] : i;

  // Nearest palette entry using a "redmean" weighted distance. A clearly
  // coloured input never maps to a grey: pale tints like Claude Code's
  // lavender rgb(177,185,249) are closer to light grey than to any blue.
  function nearest(value, set) {
    if (exact.has(value)) return exact.get(value);
    const key = `${value},${set === fgSet}`;
    let best = cache.get(key);
    if (best !== undefined) return best;
    const r = value >> 16, g = (value >> 8) & 0xff, b = value & 0xff;
    const coloured = chroma(value) >= COLOURED;
    let bestD = Infinity;
    for (const i of set) {
      const p = rgb[i];
      if (coloured && chroma(p) < GREY && set.some(j => chroma(rgb[j]) >= GREY)) continue;
      const pr = p >> 16, pg = (p >> 8) & 0xff, pb = p & 0xff;
      const rm = (r + pr) / 2;
      const dr = r - pr, dg = g - pg, db = b - pb;
      const d = (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
      if (d < bestD) { bestD = d; best = i; }
    }
    cache.set(key, best);
    return best;
  }

  const fgNoScreen = fgSet.filter(i => i !== screen);
  return {
    rgb, underline, screenBg: screen, border,
    defaultFg: shade(defaultFg), boldFg: shade(boldFg), dimFg: shade(dimFg),
    // mode: 'palette' (value 0-255) or 'rgb' (value 0xRRGGBB).
    fg(mode, value) {
      if (mode === 'palette' && value < 16) return shade(ansiFg[value]);
      return shade(nearest(mode === 'palette' ? xterm256(value) : value, fgNoScreen));
    },
    // Returns null when the background is effectively the screen.
    bg(mode, value) {
      const c = mode === 'palette' && value < 16
        ? ansiBg[value]
        : nearest(mode === 'palette' ? xterm256(value) : value, bgSet);
      return c === screen ? null : shade(c);
    },
  };
}

// C64 (Colodore approximation), index = C64 colour number.
const VIC_RGB = [
  0x000000, 0xffffff, 0x813338, 0x75cec8, 0x8e3c97, 0x56ac4d, 0x2e2c9b, 0xedf171,
  0x8e5029, 0x553800, 0xc46c71, 0x4a4a4a, 0x7b7b7b, 0xa9ff9f, 0x706deb, 0xb2b2b2,
];
// C128 VDC, index = RGBI attribute bits (R=8, G=4, B=2, I=1).
const RGBI_RGB = [
  0x000000, 0x555555, 0x0000aa, 0x5555ff, 0x00aa00, 0x55ff55, 0x00aaaa, 0x55ffff,
  0xaa0000, 0xff5555, 0xaa00aa, 0xff55ff, 0xaa5500, 0xffff55, 0xaaaaaa, 0xffffff,
];

// Per theme, per palette. ANSI tables are hand-mapped for readability on the
// theme's screen colour.
const DARK = {
  vic: {
    rgb: VIC_RGB,
    ansiFg: [11, 2, 5, 7, 14, 4, 3, 15, 12, 10, 13, 7, 14, 4, 3, 1],
    ansiBg: [0, 2, 5, 7, 6, 4, 3, 15, 11, 10, 13, 7, 14, 4, 3, 1],
    exact: new Map(CLAUDE_BLUES.map(c => [c, 14])), // light blue
    defaultFg: 15, boldFg: 1, dimFg: 12, // light grey, white, grey
  },
  // ANSI maps exactly, except black and dark blue text, which would be unreadable.
  rgbi: {
    rgb: RGBI_RGB,
    ansiFg: [1, 8, 4, 12, 3, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15],
    ansiBg: [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15],
    exact: new Map(CLAUDE_BLUES.map(c => [c, 3])), // light blue
    defaultFg: 14, boldFg: 15, dimFg: 1, // light grey, white, dark grey
  },
};

// Text on white; coloured backgrounds only in colours dark enough for the
// white text that shows through them.
const VIC_ON_WHITE = [0, 2, 4, 5, 6, 8, 9, 10, 11, 12, 14];
const RGBI_ON_WHITE = [0, 1, 2, 3, 4, 6, 8, 9, 10, 11, 12];
const LIGHT = {
  vic: {
    ...DARK.vic, screen: 1, border: 15, fgSet: VIC_ON_WHITE, bgSet: VIC_ON_WHITE,
    ansiFg: [0, 2, 5, 8, 6, 4, 14, 12, 11, 10, 5, 8, 14, 4, 14, 12],
    ansiBg: [0, 2, 5, 8, 6, 4, 14, 12, 11, 10, 5, 8, 14, 4, 14, 1],
    defaultFg: 0, boldFg: 0, dimFg: 12, // black, black, grey
  },
  rgbi: {
    ...DARK.rgbi, screen: 15, fgSet: RGBI_ON_WHITE, bgSet: RGBI_ON_WHITE,
    ansiFg: [0, 8, 4, 12, 2, 10, 6, 1, 1, 9, 4, 12, 3, 11, 6, 1],
    ansiBg: [0, 8, 4, 12, 2, 10, 6, 1, 1, 9, 4, 12, 3, 11, 6, 15],
    defaultFg: 0, boldFg: 0, dimFg: 1, // black, black, dark grey
  },
};

// The C64's power-on look: light blue on blue. Blue text becomes light blue.
// The VDC's light blue is too dark on its blue, so the C128 uses light cyan.
const CLASSIC = {
  vic: {
    ...DARK.vic, screen: 6, border: 14, fgSet: ALL.filter(i => ![6, 9, 11].includes(i)),
    ansiFg: [0, 10, 5, 7, 14, 4, 3, 15, 12, 10, 13, 7, 14, 4, 3, 1],
    ansiBg: [0, 2, 5, 7, 6, 4, 3, 15, 11, 10, 13, 7, 14, 4, 3, 1],
    defaultFg: 14, boldFg: 1, dimFg: 15, // light blue, white, light grey
  },
  rgbi: {
    ...DARK.rgbi, screen: 2, fgSet: ALL.filter(i => ![1, 2].includes(i)),
    ansiFg: [0, 9, 4, 12, 3, 10, 6, 14, 14, 9, 5, 13, 3, 11, 7, 15],
    ansiBg: [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15],
    defaultFg: 7, boldFg: 15, dimFg: 3, // light cyan, white, light blue (as dark as the VDC's blue allows)
  },
};

// Monochrome monitors: the dark theme, then every colour by its brightness.
const mono = (vicRamp, rgbiRamp) => ({
  vic: { ...DARK.vic, ramp: vicRamp },
  rgbi: { ...DARK.rgbi, ramp: rgbiRamp },
});
const THEMES = {
  dark: DARK,
  light: LIGHT,
  classic: CLASSIC,
  green: mono([[0.6, 5], [1, 13]], [[0.6, 4], [1, 5]]),
  amber: mono([[0.5, 9], [0.8, 8], [1, 7]], [[0.8, 12], [1, 13]]),
};
export const THEME_NAMES = Object.keys(THEMES);

const palettes = new Map();

// The palette for `kind` ('vic' or 'rgbi') in theme `name`.
export function palette(kind, name = 'dark') {
  const key = `${kind}/${name}`;
  if (!palettes.has(key)) {
    const theme = THEMES[name];
    if (!theme) throw new Error(`unknown theme ${name} (${THEME_NAMES.join(', ')})`);
    palettes.set(key, makePalette({ ...theme[kind], underline: kind === 'rgbi' ? 0x20 : 0 }));
  }
  return palettes.get(key);
}

export const VIC = palette('vic');
export const RGBI = palette('rgbi');

// Reply to an OSC 10 (default foreground), 11 (background) or 4 (palette
// entry) query with the colours the client actually shows, or null if `data`
// isn't a query. Replies end with ST.
export function oscReply(code, data, pal) {
  const spec = c => 'rgb:' + [c >> 16, (c >> 8) & 0xff, c & 0xff]
    .map(v => v.toString(16).padStart(2, '0').repeat(2)).join('/');
  const reply = (body, c) => `\x1b]${body};${spec(c)}\x1b\\`;
  if (code === 10 && data === '?') return reply('10', pal.rgb[pal.defaultFg]);
  if (code === 11 && data === '?') return reply('11', pal.rgb[pal.screenBg]);
  if (code === 4) {
    const parts = data.split(';');
    let out = '';
    for (let k = 0; k + 1 < parts.length; k += 2) {
      const n = Number(parts[k]);
      if (parts[k + 1] !== '?' || !(n >= 0 && n < 256)) continue;
      out += reply(`4;${n}`, pal.rgb[pal.fg('palette', n)]);
    }
    return out || null;
  }
  return null;
}
