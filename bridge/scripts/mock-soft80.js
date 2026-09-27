// Preview of the C64's soft 80-column screen without an emulator: runs a
// command in an 80x25 headless terminal, takes the bridge's snapshot for that
// display (colours already shared per pair), and draws it into a 320x200
// hi-res bitmap with the 4x8 font, with its sprites on top. Writes a PPM.
// usage: node scripts/mock-soft80.js out.ppm <wait ms> [keys] -- cmd [args...]

import { writeFileSync } from 'node:fs';
import pty from 'node-pty';
import xterm from '@xterm/headless';
import { snapshot } from '../src/screen.js';
import { DISPLAY } from '../src/protocol.js';
import { VIC } from '../src/colors.js';
import { FONT4 } from '../src/font4x8.js';

const sep = process.argv.indexOf('--');
const [out, wait = '1500', keys = ''] = process.argv.slice(2, sep);
const [cmd, ...args] = process.argv.slice(sep + 1);
const COLS = 80, ROWS = 25;

const term = new xterm.Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
const proc = pty.spawn(cmd, args, {
  name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: process.cwd(),
  env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
});
proc.onData(d => term.write(d));
await new Promise(r => setTimeout(r, Number(wait)));
if (keys) { proc.write(keys.replace(/\\r/g, '\r')); await new Promise(r => setTimeout(r, 800)); }
await new Promise(r => term.write('', r));

const { glyph, color, sprites } = snapshot(term, 0, DISPLAY.C64_80);
proc.kill();

// Rows of 4 pixels for a screen code; bit 7 = inverse.
function rows4(code) {
  const g = FONT4[code & 0x7f];
  return g.map(r => (code & 0x80 ? ~r : r) & 0xf);
}

const W = 320, H = 200;
const px = Buffer.alloc(W * H * 3);
for (let row = 0; row < ROWS; row++) {
  for (let cell = 0; cell < COLS / 2; cell++) {
    const [a, b] = [row * COLS + cell * 2, row * COLS + cell * 2 + 1];
    const fg = VIC.rgb[color[a]]; // equal to color[b]
    for (const [k, i] of [[0, a], [1, b]]) {
      const r4 = rows4(glyph[i]);
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 4; x++) {
          const on = (r4[y] >> (3 - x)) & 1;
          const o = ((row * 8 + y) * W + cell * 8 + k * 4 + x) * 3;
          const c = on ? fg : 0;
          px[o] = c >> 16; px[o + 1] = (c >> 8) & 0xff; px[o + 2] = c & 0xff;
        }
      }
    }
  }
}
for (const s of sprites) {
  const c = VIC.rgb[s.color];
  for (let line = 0; line < 21; line++) {
    for (let x = 0; x < 24; x++) {
      if (!((s.data[line * 3 + (x >> 3)] << (x & 7)) & 0x80)) continue;
      const X = s.col * 4 + x, Y = s.row * 8 + line;
      if (X >= W || Y >= H) continue;
      const o = (Y * W + X) * 3;
      px[o] = c >> 16; px[o + 1] = (c >> 8) & 0xff; px[o + 2] = c & 0xff;
    }
  }
}
console.log(`${sprites.length} sprites`);
writeFileSync(out, Buffer.concat([Buffer.from(`P6\n${W} ${H}\n255\n`), px]));
process.exit(0);
