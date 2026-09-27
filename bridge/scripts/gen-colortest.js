// Writes colortest.ans: a 40x25 screen of ANSI colours, 256-colour and
// truecolor samples, attributes and custom glyphs. `cat colortest.ans` in a
// PETTY session to see how each maps onto the C64 or C128 palette.

import { writeFileSync } from 'node:fs';

const out = new URL('../../colortest.ans', import.meta.url);
const E = s => `\x1b[${s}m`;
const R = E(0);
const lines = [];

lines.push(`${E(1)}PETTY colour test${R}`);
lines.push('');
lines.push('       0   1   2   3   4   5   6   7');
lines.push('fg     ' + [0, 1, 2, 3, 4, 5, 6, 7].map(i => `${E(30 + i)}Aa${i}${R} `).join(''));
lines.push('bright ' + [0, 1, 2, 3, 4, 5, 6, 7].map(i => `${E(90 + i)}Aa${i}${R} `).join(''));
lines.push('bg     ' + [0, 1, 2, 3, 4, 5, 6, 7].map(i => `${E(40 + i)} ${i} ${R} `).join(''));
lines.push('bg hi  ' + [0, 1, 2, 3, 4, 5, 6, 7].map(i => `${E(100 + i)} ${i} ${R} `).join(''));
lines.push('');
lines.push(`${E(1)}bold${R} ${E(2)}dim${R} ${E(7)}inverse${R} ${E(4)}under${R} ${E('38;2;215;119;87')}claude${R} ${E('38;2;177;185;249')}blue${R}`);
lines.push('');
lines.push('256-colour cube (red rows, green x blue)');
for (let r = 0; r < 6; r++) {
  let s = '';
  for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) s += `${E(`48;5;${16 + r * 36 + g * 6 + b}`)} `;
  lines.push(s + R);
}
let grey = '';
for (let i = 232; i < 256; i++) grey += `${E(`48;5;${i}`)} `;
lines.push(grey + R + ' greys');

// Truecolor hue sweep.
let hue = '';
for (let i = 0; i < 36; i++) {
  const h = i / 36 * 6, x = Math.round(255 * (1 - Math.abs(h % 2 - 1)));
  const [r, g, b] = [[255, x, 0], [x, 255, 0], [0, 255, x], [0, x, 255], [x, 0, 255], [255, 0, x]][Math.floor(h)];
  hue += `${E(`48;2;${r};${g};${b}`)} `;
}
lines.push(hue + R + ' rgb');
lines.push('');
lines.push('╭──────╮ ⏺ ✻ ✳ ✓ ✗ … ↑ ↓ → ▶ ❯');
lines.push('│ box  │ █▐▄▛▜▙▟ \\^_`{|}~');
lines.push('╰──────╯');

writeFileSync(out, lines.join('\r\n') + '\r\n');
console.log(`wrote ${out.pathname}`);
