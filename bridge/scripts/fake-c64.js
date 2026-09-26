// Pretends to be the C64: connects to the bridge, types keys, prints the decoded screen.
// usage: node scripts/fake-c64.js [port] "text to type"
import net from 'node:net';
import { Decoder, MSG, OP, COLS, ROWS } from '../src/protocol.js';
import { MATRIX, SHIFT } from '../src/keymap.js';
import { screenCodeToChar } from '../src/glyphs.js';

const port = Number(process.argv[2] ?? 6464);
const typed = process.argv[3] ?? 'echo hello from the c64\r';
const dec = new Decoder();
const sock = net.connect(port, '127.0.0.1', () => sock.write(Buffer.from([MSG.HELLO])));
sock.on('data', d => {
  dec.feed(d);
  for (const b of d) if (b === OP.FRAME) sock.write(Buffer.from([MSG.ACK]));
});

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
    for (let r = 0; r < ROWS; r++) {
      let line = '';
      for (let c = 0; c < COLS; c++) line += screenCodeToChar(dec.glyph[r * COLS + c]);
      console.log('|' + line + '|');
    }
    sock.end();
  }, 800);
}, 800);
