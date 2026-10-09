// Limits and small fixes found in review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { decodePNG } from '../src/image.js';
import { palette } from '../src/colors.js';
import { keyToBytes, MATRIX } from '../src/keymap.js';

function bigPng(width, height, depth = 1) {
  const stride = Math.ceil(width * depth / 8);
  const chunk = (name, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(name, 4, 'latin1'); data.copy(b, 8); return b; };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = depth; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc((stride + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}

test('a PNG that claims too many pixels is refused before anything is allocated', () => {
  assert.throws(() => decodePNG(bigPng(16000, 16000)), /too big/);
  assert.equal(decodePNG(bigPng(64, 64)).width, 64);
});

test('a PNG whose data is short is refused', () => {
  const p = bigPng(64, 64);
  const lie = Buffer.from(p); lie.writeUInt32BE(128, 8 + 8 + 4); // IHDR height 128, data for 64
  assert.throws(() => decodePNG(lie), /short|too big|incorrect|unexpected/i);
});

test('foreground and background lookups of one colour do not share a cache entry (classic theme)', () => {
  const blue = 0x2e2c9b; // the classic screen colour, as a background
  const a = palette('vic', 'classic'); // module-level cache is per theme: use a fresh read order each way
  const bg = a.bg('rgb', blue), fg = a.fg('rgb', blue);
  assert.equal(bg, null, 'as a background it is the screen');
  assert.notEqual(fg, a.screenBg, 'as text it must not vanish into the screen');
  const b = palette('rgbi', 'classic');
  const fg2 = b.fg('rgb', 0x0000aa), bg2 = b.bg('rgb', 0x0000aa);
  assert.notEqual(fg2, b.screenBg);
  assert.equal(bg2, null);
});

test('C=+CRSR up/down on the alternate screen follows application cursor mode', () => {
  const up = MATRIX.indexOf('CRSR↕');
  const mouse = { tracking: 'none', encoding: 'DEFAULT', altScreen: true };
  assert.equal(keyToBytes(up, 1 | 2, { mouse }), '\x1b[A');
  assert.equal(keyToBytes(up, 1 | 2, { mouse, appCursor: true }), '\x1bOA');
});
