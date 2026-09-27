// Pretends to be the C64 (or a C128, or the C64 in soft 80 columns or
// hi-res): connects to the bridge, types keys, prints the decoded screen.
// usage: node scripts/fake-c64.js [--c128 | --soft80 | --hires] [port] "text to type"
import net from 'node:net';
import { parseArgs } from 'node:util';
import { Decoder, DISPLAY, MSG, OP, VDC } from '../src/protocol.js';
import { MATRIX, SHIFT } from '../src/keymap.js';
import { screenCodeToChar } from '../src/glyphs.js';
import { EXT_GLYPHS } from '../src/extglyphs.js';

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    c128: { type: 'boolean', default: false },
    soft80: { type: 'boolean', default: false },
    hires: { type: 'boolean', default: false },
  },
});
const port = Number(positionals[0] ?? 6464);
const typed = positionals[1] ?? 'echo hello from the c64\r';
const display = opt.c128 ? DISPLAY.C128 : opt.soft80 ? DISPLAY.C64_80 : opt.hires ? DISPLAY.C64_HIRES : DISPLAY.C64;
const { cols, rows } = display;
const hello = display === DISPLAY.C64 ? [MSG.HELLO] : [MSG.HELLO_ON, display.id];
const dec = new Decoder(cols, rows);
const sock = net.connect(port, '127.0.0.1', () => sock.write(Buffer.from(hello)));
sock.on('data', d => {
  dec.feed(d);
  for (const b of d) if (b === OP.FRAME) sock.write(Buffer.from([MSG.ACK]));
});

// Characters from 128 up (on the C128, with the alternate set attribute)
// are whatever GLYPH loaded: find it by its pixels. The C128 reverses a cell
// with an attribute instead.
const byPixels = new Map(EXT_GLYPHS.map(g => [g.data.join(), g.ch]));
function charAt(i) {
  let code = dec.glyph[i];
  if (display === DISPLAY.C128 && dec.color[i] & VDC.ALT) code += 256;
  if (display.ext && code >= 128) return byPixels.get(dec.glyphs.get(code)?.join()) ?? '?';
  return screenCodeToChar(display.reverse && dec.color[i] & VDC.RVS ? code | 128 : code);
}

function keyFor(ch) {
  if (ch === '\r') return [MATRIX.indexOf('RETURN'), 0];
  if (ch === ' ') return [MATRIX.indexOf('SPACE'), 0];
  if (ch >= 'A' && ch <= 'Z') return [MATRIX.indexOf(ch.toLowerCase()), SHIFT];
  return [MATRIX.indexOf(ch), 0];
}

setTimeout(async () => {
  for (const ch of typed) {
    sock.write(Buffer.from([MSG.KEY, ...keyFor(ch)]));
    await new Promise(r => setTimeout(r, 20));
  }
  setTimeout(() => {
    for (let r = 0; r < rows; r++) {
      let line = '';
      for (let c = 0; c < cols; c++) line += charAt(r * cols + c);
      console.log('|' + line + '|');
    }
    sock.end();
  }, 800);
}, 800);
