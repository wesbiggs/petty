// Pretends to be the C64 client (or, with --c128, the C128 client): connects to
// the bridge, types keys, prints the decoded screen. As the C64 client, it starts
// on its hi-res screen (--display c64, c64-80 or c64-53: another), says it can
// switch (MODES), and switches when the bridge says (MODE).
// usage: node scripts/fake-c64.js [--c128 | --display KEY] [--serial dev] [port] "text to type"
import net from 'node:net';
import { parseArgs } from 'node:util';
import { Decoder, DISPLAY, MSG, OP, VDC, displayById, displayByKey } from '../src/protocol.js';
import { MATRIX, SHIFT } from '../src/keymap.js';
import { screenCodeToChar } from '../src/glyphs.js';
import { EXT_GLYPHS } from '../src/extglyphs.js';
import { openSerial } from '../src/serial.js';

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    c128: { type: 'boolean', default: false },
    display: { type: 'string', default: 'c64-hires' },
    serial: { type: 'string' },
    baud: { type: 'string', default: '38400' },
  },
});
const port = Number(positionals[0] ?? 6464);
const typed = positionals[1] ?? 'echo hello from the c64\r';
const MODES = [DISPLAY.C64, DISPLAY.C64_HIRES, DISPLAY.C64_80, DISPLAY.C64_53];
let display = opt.c128 ? DISPLAY.C128 : displayByKey(opt.display);
if (!opt.c128 && !MODES.includes(display)) {
  console.error(`--display ${opt.display}: c64, c64-hires, c64-80 or c64-53`);
  process.exit(2);
}
const hello = () => opt.c128
  ? [MSG.HELLO_ON, display.id]
  : [MSG.HELLO_ON, display.id, MSG.MODES, 0x80 | MODES.reduce((m, d) => m | 1 << d.id, 0)];
let dec = new Decoder(display.cols, display.rows);
const sock = opt.serial ? openSerial(opt.serial, Number(opt.baud)) : net.connect(port, '127.0.0.1');
if (opt.serial) sock.write(Buffer.from(hello()));
else sock.on('connect', () => sock.write(Buffer.from(hello())));
sock.on('data', d => {
  dec.feed(d);
  for (const b of d) if (b === OP.FRAME) sock.write(Buffer.from([MSG.ACK]));
  // MODE comes last (the bridge waits for the HELLO_ON).
  if (dec.mode !== undefined && MODES.includes(displayById(dec.mode))) {
    display = displayById(dec.mode);
    dec = new Decoder(display.cols, display.rows);
    sock.write(Buffer.from(hello()));
  }
});

// Characters from 128 up (on the C128, with the alternate set attribute)
// are whatever GLYPH loaded: find it by its pixels. The C128 reverses a cell
// with an attribute instead.
const byPixels = new Map(EXT_GLYPHS.map(g => [g.data.join(), g.ch]));
function charAt(i) {
  if (dec.bits[i]) return '▒'; // image cell (BITS)
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
    for (let r = 0; r < display.rows; r++) {
      let line = '';
      for (let c = 0; c < display.cols; c++) line += charAt(r * display.cols + c);
      console.log('|' + line + '|');
    }
    process.exit(0); // closing a serial stream reports an abort
  }, 800);
}, 800);
