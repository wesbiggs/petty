import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import xterm from '@xterm/headless';
import { DISPLAY, OP, VIEW, Decoder, encodeFrame, encodeReset, encodePicture } from '../src/protocol.js';
import { snapshot } from '../src/screen.js';
import { INVERSE } from '../src/glyphs.js';
import { IMAGE, InlineImages, decodePNG, decodeImage, fitSize, imageCell, koala, multicolourPicture, toCells, toKoala } from '../src/image.js';
import { VIC_RGB } from '../src/colors.js';

// A PNG from unfiltered rows of raw samples.
function png(width, height, type, depth, rows, plte) {
  const chunk = (name, data) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0);
    b.write(name, 4, 'latin1');
    data.copy(b, 8);
    return b; // the decoder ignores CRCs
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth; ihdr[9] = type;
  const raw = Buffer.concat(rows.map(r => Buffer.from([0, ...r])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(plte ? [chunk('PLTE', Buffer.from(plte))] : []),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const rgbOf = c => [VIC_RGB[c] >> 16, VIC_RGB[c] >> 8 & 255, VIC_RGB[c] & 255];

// The colour of each of a cell's 64 pixels.
const cellPixels = bytes => Array.from({ length: 64 }, (_, k) =>
  bytes[k >> 3] >> (7 - (k & 7)) & 1 ? bytes[8] >> 4 : bytes[8] & 15);

// A Doodle! picture (hi-res): random pixels, two random colours per cell.
function doodle(seed = 1) {
  let s = seed;
  const rand = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) >> 8;
  const buf = Buffer.alloc(9218);
  buf.writeUInt16LE(0x5c00, 0);
  for (let i = 0; i < 1000; i++) buf[2 + i] = rand() & 0xff;
  for (let i = 0; i < 8000; i++) buf[1026 + i] = rand() & 0xff;
  return buf;
}
const doodleCell = (buf, i) => [...buf.subarray(1026 + i * 8, 1034 + i * 8), buf[2 + i]];

const write = (term, s) => new Promise(r => term.write(s, r));

function terminal(display = DISPLAY.C64_HIRES) {
  const term = new xterm.Terminal({ cols: display.cols, rows: display.rows, allowProposedApi: true });
  const images = new InlineImages(term, () => ({ maxCols: display.cols, maxRows: display.rows, bg: 0 }));
  term.parser.registerOscHandler(1337, data => images.osc(data));
  return term;
}

const osc = (file, args = '') => `\x1b]1337;File=${args}inline=1:${file.toString('base64')}\x07`;

test('PNG: RGB, palette and grey with alpha decode to RGBA', () => {
  let img = decodePNG(png(2, 1, 2, 8, [[255, 0, 0, 0, 0, 255]]));
  assert.deepEqual([...img.rgba], [255, 0, 0, 255, 0, 0, 255, 255]);
  img = decodePNG(png(3, 1, 3, 1, [[0b01000000]], [0, 0, 0, 255, 255, 255]));
  assert.deepEqual([...img.rgba], [0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
  img = decodePNG(png(1, 1, 4, 8, [[128, 0]]));
  assert.deepEqual([...img.rgba], [128, 128, 128, 0]);
});

test('size: own size, shrunk to fit, or as asked', () => {
  assert.deepEqual(fitSize(16, 8, {}, 40, 25), { w: 16, h: 8 });
  assert.deepEqual(fitSize(640, 400, {}, 40, 25), { w: 320, h: 200 });
  assert.deepEqual(fitSize(100, 50, { width: '10' }, 40, 25), { w: 80, h: 40 });
  assert.deepEqual(fitSize(100, 50, { width: '50%' }, 40, 25), { w: 160, h: 80 });
  assert.deepEqual(fitSize(100, 50, { width: '8', height: '8', preserveAspectRatio: '0' }, 40, 25), { w: 64, h: 64 });
});

test('a hi-res picture converts pixel for pixel', () => {
  const buf = doodle();
  const img = decodeImage(buf);
  assert.equal(img.format, 'Doodle');
  const t = Date.now();
  const { cols, rows, keys } = toCells(img, {}, 40, 25, 0);
  assert.ok(Date.now() - t < 3000, `conversion took ${Date.now() - t} ms`);
  assert.deepEqual([cols, rows], [40, 25]);
  for (let i = 0; i < 1000; i++) {
    assert.deepEqual(cellPixels(imageCell(keys[i])), cellPixels(doodleCell(buf, i)), `cell ${i}`);
  }
});

test('a flat colour image is that colour; a mix of two is dithered', () => {
  const flat = { width: 8, height: 8, rgba: new Uint8Array(256).map((_, k) => [...rgbOf(5), 255][k & 3]) };
  let { keys } = toCells(flat, {}, 40, 25, 0);
  assert.ok(cellPixels(imageCell(keys[0])).every(c => c === 5));
  const grey = { width: 8, height: 8, rgba: new Uint8Array(256).map((_, k) => (k & 3) === 3 ? 255 : 128) };
  ({ keys } = toCells(grey, {}, 40, 25, 0));
  const px = cellPixels(imageCell(keys[0]));
  assert.ok(px.every(c => [11, 12, 15, 0, 1].includes(c)), `greys only: ${px}`);
});

test('imgcat: an image at the cursor, drawn with BITS', async () => {
  const term = terminal();
  const file = png(16, 8, 2, 8, Array.from({ length: 8 }, () => Array(48).fill(255)));
  await write(term, `ab${osc(file)}\r\nc`);
  const want = snapshot(term, 0, DISPLAY.C64_HIRES);
  // Placed after "ab", the cursor after it; then a new line.
  assert.ok(want.glyph[2] >= IMAGE && want.glyph[3] >= IMAGE && want.glyph[4] < IMAGE);
  assert.equal(term.buffer.active.cursorY, 1);

  const dec = new Decoder(40, 25);
  const { bytes } = encodeReset(want, 0, 0, 0xf0);
  dec.feed(bytes);
  for (const i of [2, 3]) {
    assert.deepEqual([...dec.bits[i]], [...imageCell(want.glyph[i] - IMAGE).subarray(0, 8)]);
    assert.equal(dec.color[i], imageCell(want.glyph[i] - IMAGE)[8]);
    assert.ok(cellPixels(imageCell(want.glyph[i] - IMAGE)).every(c => c === 1), 'white');
  }
  assert.equal(dec.bits[4], null);

  // Text over the image replaces it.
  await write(term, '\x1b[1;4Hx');
  const next = snapshot(term, 0, DISPLAY.C64_HIRES);
  assert.ok(next.glyph[2] >= IMAGE && next.glyph[3] < IMAGE);
});

test('a full-screen image goes out in several frames', async () => {
  const term = terminal();
  await write(term, osc(doodle(7)));
  const want = snapshot(term, 0, DISPLAY.C64_HIRES);
  const dec = new Decoder(40, 25);
  let { bytes, state, partial } = encodeReset(want, 0, 0, 0xf0, 2048);
  dec.feed(bytes);
  let frames = 1;
  while (partial) {
    assert.ok(bytes.length <= 2048 + 16, `frame of ${bytes.length} bytes`);
    ({ bytes, state, partial } = encodeFrame(state, want, 2048));
    dec.feed(bytes);
    frames++;
  }
  assert.ok(frames >= 5, `${frames} frames`);
  for (let i = 0; i < 1000; i++) {
    assert.ok(want.glyph[i] >= IMAGE, `image at ${i}`);
    assert.deepEqual([...dec.bits[i]], [...imageCell(want.glyph[i] - IMAGE).subarray(0, 8)], `cell ${i}`);
  }
  assert.deepEqual(encodeFrame(state, want).bytes.length, 1, 'nothing left');
});

test('the text screen shows an image as blocks of colour', async () => {
  const term = terminal(DISPLAY.C64);
  const file = png(8, 8, 2, 8, Array.from({ length: 8 }, () => Array(8).fill(rgbOf(2)).flat()));
  await write(term, osc(file));
  const want = snapshot(term, 0, DISPLAY.C64);
  assert.equal(want.glyph[0], 32 | INVERSE);
  assert.equal(want.color[0], 2);
});

function koalaFile() {
  const buf = Buffer.alloc(10003);
  buf.writeUInt16LE(0x6000, 0);
  for (let i = 2; i < 10002; i++) buf[i] = (i * 37) & 0xff;
  buf[10002] = 6;
  return buf;
}

test('a Koala picture loads full screen, in frames, then shows', () => {
  const file = koalaFile();
  const pic = koala(file);
  assert.equal(pic.bg, 6);
  const frames = encodePicture(pic, 2048);
  const dec = new Decoder(40, 25);
  for (const [k, f] of frames.entries()) {
    assert.ok(f.length <= 2048 + 1, `frame ${k}: ${f.length} bytes`);
    assert.equal(f.at(-1), OP.FRAME);
    dec.feed(f);
    if (k === 0) assert.equal(dec.view, VIEW.LOAD);
  }
  assert.equal(dec.view, VIEW.SHOW);
  assert.equal(dec.bg, 6);
  assert.ok(Buffer.from(dec.mem.subarray(0x6000, 0x6000 + 8000)).equals(file.subarray(2, 8002)));
  assert.ok(Buffer.from(dec.mem.subarray(0x5c00, 0x5c00 + 1000)).equals(file.subarray(8002, 9002)));
  assert.ok(Buffer.from(dec.mem.subarray(0xd800, 0xd800 + 1000)).equals(file.subarray(9002, 10002)));
  assert.equal(koala(doodle()), null, 'hi-res pictures stay inline');
});

test('multicolour conversion: a Koala picture comes back pixel for pixel', () => {
  const file = koalaFile();
  const img = decodeImage(file);
  const k = toKoala(img);
  const back = decodeImage(Buffer.concat([Buffer.from([0, 0x60]), k.bitmap, k.screen, k.colram, Buffer.from([k.bg])]));
  assert.ok(Buffer.from(back.rgba).equals(Buffer.from(img.rgba)));
});

const koalaRGBA = k => decodeImage(Buffer.concat([Buffer.from([0, 0x60]), k.bitmap, k.screen, k.colram, Buffer.from([k.bg])])).rgba;
const rgbAt = (rgba, x, y) => rgba[(y * 320 + x) * 4] << 16 | rgba[(y * 320 + x) * 4 + 1] << 8 | rgba[(y * 320 + x) * 4 + 2];

test('flat art: each colour solid, and different colours kept apart', () => {
  // Red and orange halves, neither a VIC colour: both nearest to the same brown.
  const px = [0xe3, 0x22, 0x10], px2 = [0xf0, 0x81, 0x1a];
  const img = { width: 64, height: 40, rgba: new Uint8Array(64 * 40 * 4) };
  for (let y = 0; y < 40; y++) for (let x = 0; x < 64; x++) img.rgba.set([...(x < 32 ? px : px2), 255], (y * 64 + x) * 4);
  const rgba = koalaRGBA(toKoala(img));
  const left = new Set(), right = new Set();
  for (let y = 0; y < 200; y++) for (let x = 0; x < 320; x++) (x < 160 ? left : right).add(rgbAt(rgba, x, y));
  assert.equal(left.size, 1, 'no dithering on the left');
  assert.equal(right.size, 1, 'no dithering on the right');
  assert.notEqual([...left][0], [...right][0], 'two colours stay two');
});

test('hi-res flat art: each colour solid and kept apart; -t dither dithers it', () => {
  const img = { width: 64, height: 16, rgba: new Uint8Array(64 * 16 * 4) };
  for (let y = 0; y < 16; y++) for (let x = 0; x < 64; x++) img.rgba.set([...(x < 32 ? [0xe3, 0x22, 0x10] : [0xf0, 0x81, 0x1a]), 255], (y * 64 + x) * 4);
  const look = type => {
    const { cols, keys } = toCells(img, { type }, 40, 25, 0);
    const half = i => ((i % cols) < cols / 2 ? 0 : 1);
    const seen = [new Set(), new Set()];
    keys.forEach((key, i) => cellPixels(imageCell(key)).forEach(c => seen[half(i)].add(c)));
    return seen.map(s => [...s]);
  };
  const [left, right] = look();
  assert.equal(left.length, 1, `left: ${left}`);
  assert.equal(right.length, 1, `right: ${right}`);
  assert.notEqual(left[0], right[0]);
  assert.ok(look('dither').some(s => s.length > 1), 'dithered');
});

test('imgcat -t koala:flat and koala:dither pick the conversion', () => {
  const file = png(8, 8, 2, 8, Array.from({ length: 8 }, (_, y) => Array.from({ length: 24 }, (_, k) => (k % 3 === 0 ? y * 32 : 90))));
  for (const type of ['koala:flat', 'multicolour:dither', 'KOALA']) {
    assert.equal(multicolourPicture(file, { type }).bitmap.length, 8000, type);
  }
});

test('imgcat -t koala shows any picture in multicolour; otherwise only Koala files', () => {
  const file = png(16, 8, 2, 8, Array.from({ length: 8 }, () => Array(48).fill(255)));
  assert.equal(multicolourPicture(file, {}), null);
  const k = multicolourPicture(file, { type: 'Koala' });
  assert.deepEqual([k.bitmap.length, k.screen.length, k.colram.length], [8000, 1000, 1000]);
  assert.ok(multicolourPicture(koalaFile(), {}));
});

test('a picture shown full screen leaves the terminal alone', async () => {
  const term = new xterm.Terminal({ cols: 40, rows: 25, allowProposedApi: true });
  let shown = null;
  const images = new InlineImages(term, () => ({ maxCols: 40, maxRows: 25, bg: 0 }), undefined, f => {
    shown = koala(f);
    return !!shown;
  });
  term.parser.registerOscHandler(1337, data => images.osc(data));
  await write(term, osc(koalaFile()) + 'x');
  assert.ok(shown);
  assert.equal(term.buffer.active.getLine(0).translateToString(true), 'x');
});

test('an unsupported file says so in the terminal', async () => {
  const term = terminal();
  await write(term, osc(Buffer.from('hello'), `name=${Buffer.from('x.txt').toString('base64')};`));
  assert.match(term.buffer.active.getLine(0).translateToString(true), /^\[x\.txt: unsupported image/);
});
