// Writes bridge/title.ans: the start screen the bridge shows when a client first
// connects, before the program starts. 3-D block letters drawn in quadrant
// pixels (2x2 per cell), extruded down and to the right, so every cell holds
// one colour on the screen colour and looks the same on every client.

import { readFileSync, writeFileSync } from 'node:fs';

const out = new URL('../title.ans', import.meta.url);
// The version shown: $VERSION (a release tag, say v1.0.0), or the bridge's.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const VERSION = (process.env.VERSION || pkg.version).replace(/^v/, '');
const COLS = 40, ROWS = 25;
const W = COLS * 2, H = ROWS * 2;

// Colours as the C64's own (VIC_RGB in colors.js), so they map exactly there
// and to the nearest match on the C128 and in the other themes.
const C = {
  white: 0xffffff, red: 0x813338, cyan: 0x75cec8, purple: 0x8e3c97, green: 0x56ac4d,
  blue: 0x2e2c9b, yellow: 0xedf171, orange: 0x8e5029, brown: 0x553800, lred: 0xc46c71,
  dgrey: 0x4a4a4a, grey: 0x7b7b7b, lgreen: 0xa9ff9f, lblue: 0x706deb, lgrey: 0xb2b2b2,
};

// Letters, 14 quadrant pixels (7 cells) high; strokes are 4 wide and 2 high,
// so the edges fall on cell boundaries.
const FONT = {
  P: [
    '########..',
    '#########.',
    '####..####',
    '####..####',
    '####..####',
    '#########.',
    '########..',
    '####......',
    '####......',
    '####......',
    '####......',
    '####......',
    '####......',
    '####......',
  ],
  E: [
    '##########',
    '##########',
    '####......',
    '####......',
    '####......',
    '########..',
    '########..',
    '####......',
    '####......',
    '####......',
    '####......',
    '####......',
    '##########',
    '##########',
  ],
  T: [
    '############',
    '############',
    '....####....',
    '....####....',
    '....####....',
    '....####....',
    '....####....',
    '....####....',
    '....####....',
    '....####....',
    '....####....',
    '....####....',
    '....####....',
    '....####....',
  ],
  Y: [
    '####....####',
    '####....####',
    '####....####',
    '####....####',
    '.####..####.',
    '..########..',
    '...######...',
    '....####....',
    '....####....',
    '....####....',
    '....####....',
    '....####....',
    '....####....',
    '....####....',
  ],
};

// Face colours: the top three rows light, the rest a shade darker. The
// extrusion is lit from the top left: the right-hand sides in grey, the
// undersides darker.
const LETTERS = [
  { ch: 'P', face: [C.lred, C.red] },
  { ch: 'E', face: [C.yellow, C.orange] },
  { ch: 'T', face: [C.lgreen, C.green] },
  { ch: 'T', face: [C.cyan, C.lblue] },
  { ch: 'Y', face: [C.lblue, C.purple] },
];
const SIDE = C.grey, UNDER = C.dgrey;
const DEPTH = 2; // extrusion, in quadrant pixels: one cell diagonally
const GAP = 4;

// Quadrant pixel canvas: {colour, layer} per pixel; higher layers win.
const px = Array.from({ length: H }, () => Array(W).fill(null));
const plot = (x, y, colour, layer) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  if (!px[y][x] || px[y][x].layer <= layer) px[y][x] = { colour, layer };
};

const width = ch => FONT[ch][0].length;
const textW = LETTERS.reduce((n, { ch }) => n + width(ch) + GAP, -GAP + DEPTH);
const left = Math.floor((W - textW) / 2) & ~1, top = 4;
let x0 = left;
for (const { ch, face } of LETTERS) {
  const glyph = FONT[ch], w = width(ch);
  const on = (x, y) => glyph[y]?.[x] === '#';
  // Extrusion first, deepest step first so the nearer steps cover it.
  for (let d = DEPTH; d >= 1; d--) {
    for (let y = 0; y < 14; y++) for (let x = 0; x < w; x++) {
      if (on(x, y)) plot(x0 + x + d, top + y + d, on(x, y + 1) ? SIDE : UNDER, 1);
    }
  }
  for (let y = 0; y < 14; y++) for (let x = 0; x < w; x++) {
    if (on(x, y)) plot(x0 + x, top + y, face[y < 6 ? 0 : 1], 2);
  }
  x0 += w + GAP;
}

// A floor: a grid receding to the horizon. Its cross lines get further
// apart nearer the viewer; the lines running away from the viewer converge
// on a vanishing point above the horizon.
const horizon = top + 14 + DEPTH + 3, floorBottom = 2 * 20;
const CROSS = [0, 2, 5, 9, 15].map(dy => horizon + dy);
const vx = W / 2, vy = horizon - 10;
const shade = y => (y < CROSS[2] ? C.blue : y < CROSS[3] ? C.purple : C.lred);
for (let y = horizon; y < floorBottom; y++) {
  if (CROSS.includes(y)) for (let x = 0; x < W; x++) plot(x, y, shade(y), 0);
  // 10 pixels apart at the bottom edge, starting below the first cross line
  // (above it they would merge); each fills its span across the pixel row,
  // so it stays unbroken.
  if (y > CROSS[1]) for (let k = -8; k <= 8; k++) {
    const at = t => vx + k * 10 * (t - vy) / (floorBottom - vy);
    const [x0, x1] = [at(y), at(y + 1)].sort((a, b) => a - b);
    for (let x = Math.round(x0); x <= Math.max(Math.round(x0), Math.round(x1) - 1); x++) plot(x, y, shade(y), 0);
  }
}

// Quadrants: bit 3 = top left, 2 = top right, 1 = bottom left, 0 = bottom right.
const QUAD = [' ', '▗', '▖', '▄', '▝', '▐', '▞', '▟', '▘', '▚', '▌', '▙', '▀', '▜', '▛', '█'];
const E = s => `\x1b[${s}m`;
const fg = c => E(`38;2;${c >> 16};${(c >> 8) & 255};${c & 255}`);

// One colour per cell: the top layer's colour, its pixels only.
function cell(cx, cy) {
  const q = [px[cy * 2][cx * 2], px[cy * 2][cx * 2 + 1], px[cy * 2 + 1][cx * 2], px[cy * 2 + 1][cx * 2 + 1]];
  const lit = q.filter(Boolean);
  if (!lit.length) return null;
  const layer = Math.max(...lit.map(p => p.layer));
  // Most common colour among the top layer's pixels.
  const counts = new Map();
  for (const p of lit) if (p.layer === layer) counts.set(p.colour, (counts.get(p.colour) ?? 0) + 1);
  const colour = [...counts].sort((a, b) => b[1] - a[1])[0][0];
  let bits = 0;
  q.forEach((p, i) => { if (p && p.layer === layer && p.colour === colour) bits |= 8 >> i; });
  // No diagonal quadrants on the C64: fill them in.
  if (bits === 6 || bits === 9) bits = 15;
  return { ch: QUAD[bits], colour };
}

// Text rows: [row, [[text, colour], ...]], centred.
const TEXT = [
  [21, [['Commodore 64 Terminal', C.lgreen], [` v${VERSION}`, C.green]]],
  [22, [['(C) 2026 Wes Biggs', C.grey], [' <github@wbig.gs>', C.lgrey]]],
  [24, [['press any key', C.grey]]],
];

const lines = [];
for (let cy = 0; cy < ROWS; cy++) {
  let s = '', last = null;
  const text = TEXT.find(([r]) => r === cy);
  if (text) {
    const len = text[1].reduce((n, [t]) => n + t.length, 0);
    s += ' '.repeat(Math.floor((COLS - len) / 2));
    for (const [t, c] of text[1]) s += fg(c) + t;
    lines.push(s + E(0));
    continue;
  }
  let row = [];
  for (let cx = 0; cx < COLS; cx++) row.push(cell(cx, cy));
  while (row.length && !row[row.length - 1]) row.pop();
  for (const c of row) {
    if (!c) { s += ' '; continue; }
    if (c.colour !== last) { s += fg(c.colour); last = c.colour; }
    s += c.ch;
  }
  lines.push(s + (last !== null ? E(0) : ''));
}

// Clear the screen and draw; no newline after the last row, so nothing
// scrolls. The cursor is left alone, so `cat title.ans` doesn't lose it; the
// bridge hides it while the start screen shows.
writeFileSync(out, '\x1b[H\x1b[2J' + lines.join('\r\n'));
console.log(`wrote ${out.pathname}`);
