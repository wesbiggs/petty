import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DISPLAY, OP, Decoder, encodeFrame, encodeReset, sameLook } from '../src/protocol.js';
import { toScreenCode, screenCodeToChar, INVERSE } from '../src/glyphs.js';
import { keyToBytes, MATRIX, SHIFT, CTRL, CBM, ALT } from '../src/keymap.js';
import { VIC, RGBI, palette, oscReply, THEME_NAMES } from '../src/colors.js';
import { snapshot } from '../src/screen.js';
import { FONT4 } from '../src/font4x8.js';
import xterm from '@xterm/headless';

const SPACE = 32;

function blank({ cols, rows } = DISPLAY.C64) {
  const glyph = new Int16Array(cols * rows).fill(SPACE);
  return { cols, rows, glyph, color: new Int16Array(cols * rows).fill(15) };
}

function text(screen, row, col, s, color = 15) {
  [...s].forEach((ch, k) => {
    screen.glyph[row * screen.cols + col + k] = toScreenCode(ch);
    screen.color[row * screen.cols + col + k] = color;
  });
}

function assertShows(dec, want) {
  for (let i = 0; i < want.glyph.length; i++) {
    assert.equal(dec.glyph[i], want.glyph[i], `glyph at ${i}`);
    assert.ok(sameLook(want.glyph[i], dec.color[i], want.color[i]), `color at ${i}: ${dec.color[i]} vs ${want.color[i]}`);
  }
}

test('reset then incremental frames decode to the wanted screen', () => {
  const dec = new Decoder();
  let want = blank();
  text(want, 0, 0, '╭──────╮', 3);
  text(want, 1, 0, '│ ❯ hi │', 1);
  let { bytes, state } = encodeReset(want);
  dec.feed(bytes);
  assertShows(dec, want);

  text(want, 1, 5, 'yo', 7);
  ({ bytes, state } = encodeFrame(state, want));
  dec.feed(bytes);
  assertShows(dec, want);
  assert.ok(bytes.length < 12, `small update, got ${bytes.length} bytes`);

  ({ bytes } = encodeFrame(state, want));
  assert.deepEqual(bytes, [OP.FRAME], 'no change = empty frame');
});

test('scrolling output uses SCROLL', () => {
  const dec = new Decoder();
  const want = blank();
  for (let r = 0; r < 25; r++) text(want, r, 0, `line ${r} of the transcript`);
  let { bytes, state } = encodeReset(want);
  dec.feed(bytes);

  const next = blank();
  for (let r = 0; r < 25; r++) text(next, r, 0, `line ${r + 3} of the transcript`);
  ({ bytes, state } = encodeFrame(state, next));
  dec.feed(bytes);
  assertShows(dec, next);
  assert.ok(bytes.includes(OP.SCROLL));
  assert.ok(bytes.length < 120, `scroll frame ${bytes.length} bytes`);
});

for (const display of Object.values(DISPLAY)) test(`random frames stay in sync (${display.name})`, () => {
  let seed = 1;
  const rand = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const dec = new Decoder(display.cols, display.rows);
  let want = blank(display);
  let { bytes, state } = encodeReset(want);
  dec.feed(bytes);
  for (let f = 0; f < 200; f++) {
    want = { ...want, glyph: want.glyph.slice(), color: want.color.slice() };
    for (let k = rand(60); k > 0; k--) {
      const i = rand(want.glyph.length);
      want.glyph[i] = rand(4) ? rand(256) : SPACE;
      // Underline (C128) shows on spaces too.
      want.color[i] = rand(16) | (display === DISPLAY.C128 && !rand(4) ? 0x20 : 0);
    }
    ({ bytes, state } = encodeFrame(state, want));
    dec.feed(bytes);
    assertShows(dec, want);
  }
});

test('80-column screen scrolls and addresses the right half', () => {
  const dec = new Decoder(80, 25);
  const want = blank(DISPLAY.C128);
  for (let r = 0; r < 25; r++) text(want, r, 50, `right side ${r}`);
  let { bytes, state } = encodeReset(want);
  dec.feed(bytes);
  assertShows(dec, want);

  const next = blank(DISPLAY.C128);
  for (let r = 0; r < 25; r++) text(next, r, 50, `right side ${r + 2}`);
  text(next, 24, 79, 'x');
  ({ bytes, state } = encodeFrame(state, next));
  dec.feed(bytes);
  assertShows(dec, next);
  assert.ok(bytes.includes(OP.SCROLL));

  assert.throws(() => encodeFrame(state, blank()), /size/);
});

test('underlined spaces are drawn, plain spaces keep any colour', () => {
  const dec = new Decoder(80, 25);
  const want = blank(DISPLAY.C128);
  text(want, 0, 0, 'a b', 14 | 0x20); // underlined, space included
  text(want, 0, 3, ' c', 14);
  let { bytes, state } = encodeReset(want);
  dec.feed(bytes);
  assertShows(dec, want);
  assert.equal(dec.color[1], 14 | 0x20, 'underlined space');
  assert.equal(dec.color[3] & 0x20, 0, 'space after the underlined word');
});

test('soft 80 columns: each pair of cells shares one colour', async () => {
  const term = new xterm.Terminal({ cols: 80, rows: 25, allowProposedApi: true });
  // red "ab", then green "c" + space, then blue "d" + a green background cell
  await new Promise(done => term.write('\x1b[?25l\x1b[31mab\x1b[32mc \x1b[34md\x1b[42m \x1b[0m', done));
  const { color } = snapshot(term, 0, DISPLAY.C64_80);
  assert.equal(color[0], VIC.fg('palette', 1));
  assert.equal(color[1], color[0], 'a and b');
  assert.equal(color[2], VIC.fg('palette', 2), 'c keeps its colour next to a space');
  assert.equal(color[3], color[2]);
  assert.equal(color[4], VIC.bg('palette', 2), 'the solid background cell outweighs d');
  assert.equal(color[5], color[4]);
});

const soft80 = async text => {
  const term = new xterm.Terminal({ cols: 80, rows: 25, allowProposedApi: true });
  await new Promise(done => term.write('\x1b[?25l' + text, done));
  return snapshot(term, 0, DISPLAY.C64_80);
};

test('soft 80 columns: letters keep their colour over punctuation', async () => {
  const { color, sprites } = await soft80('\x1b[33m(\x1b[31mo\x1b[0m'); // "(o" in one cell
  assert.equal(color[1], VIC.fg('palette', 1), 'o stays red');
  assert.equal(color[0], color[1], '( takes the red');
  assert.deepEqual(sprites.map(s => [s.col, s.color]), [[0, VIC.fg('palette', 3)]], 'a spare sprite repaints the (');
});

test('soft 80 columns: a sprite repaints a letter that lost its colour', async () => {
  // One cell: green m (10 pixels) keeps the colour, red o (6) loses it.
  const { color, sprites } = await soft80('\x1b[32mm\x1b[31mo');
  assert.equal(color[1], VIC.fg('palette', 2), 'o drawn green in the bitmap');
  assert.equal(sprites.length, 1);
  const [s] = sprites;
  assert.deepEqual([s.col, s.row, s.color], [1, 0, VIC.fg('palette', 1)]);
  // o's pixels, and nothing else, in the sprite's first 4 columns
  const c = FONT4[toScreenCode('o')];
  for (let y = 0; y < 21; y++) {
    const bits = (s.data[y * 3] << 16) | (s.data[y * 3 + 1] << 8) | s.data[y * 3 + 2];
    assert.equal(bits, y < 8 ? c[y] << 20 : 0, `line ${y}`);
  }

  // Through the encoder: sent once, then not again, then hidden.
  const dec = new Decoder(80, 25);
  let { bytes, state } = encodeReset({ ...blank(DISPLAY.C64_80), sprites });
  dec.feed(bytes);
  assert.deepEqual(dec.sprites[0], s);
  assert.equal(dec.sprites[1], null);
  ({ bytes, state } = encodeFrame(state, { ...blank(DISPLAY.C64_80), sprites }));
  assert.deepEqual(bytes, [OP.FRAME]);
  ({ bytes } = encodeFrame(state, { ...blank(DISPLAY.C64_80), sprites: [] }));
  dec.feed(bytes);
  assert.deepEqual(bytes, [OP.NOSPRITE, 0, OP.FRAME]);
});

test('soft 80 columns: sprites group nearby losers and stop at 8', async () => {
  // "xy " in green and red: every 6 columns a cell holds x|y, and the green x
  // (6 pixels) loses to the red y (9). 12 rows of 14 conflicts.
  const line = '\x1b[32mx\x1b[31my '.repeat(26);
  const { sprites } = await soft80((line.slice(0, 80 * 12) + '\r\n').repeat(12));
  assert.equal(sprites.length, 8);
  assert.ok(sprites.every(s => s.color === VIC.fg('palette', 2)), 'all repaint a green x');
  // A sprite covers two rows, so it takes the x below as well.
  const lit = s => s.data.reduce((n, b) => n + [...b.toString(2)].filter(c => c === '1').length, 0);
  assert.ok(sprites.every(s => lit(s) === 2 * 6), 'two x per sprite');
});

test('soft 80 columns: letters get sprites before punctuation', async () => {
  // 9 cells of green "(" + red "o": the o keeps red, each ( loses; then one
  // cell where a red o loses to a green m, far from the others.
  const { sprites } = await soft80('\x1b[32m(\x1b[31mo      '.repeat(9) + '\r\n'.repeat(10) + '\x1b[32mm\x1b[31mo');
  assert.equal(sprites.length, 8);
  assert.deepEqual([sprites[0].row, sprites[0].col, sprites[0].color], [10, 1, VIC.fg('palette', 1)]);
});

test('themes', () => {
  const light = palette('vic', 'light');
  assert.deepEqual([light.screenBg, light.defaultFg], [1, 0], 'C64: black on white');
  assert.equal(light.bg('palette', 15), null, 'a white background is no background');
  assert.notEqual(light.fg('palette', 3), 7, 'no yellow text on white');
  assert.notEqual(light.bg('rgb', 0x69db7c), 13, 'no light green bar under white text');

  const classic = palette('vic', 'classic');
  assert.deepEqual([classic.screenBg, classic.border, classic.defaultFg], [6, 14, 14]);
  assert.equal(classic.bg('palette', 4), null, 'blue background = the screen');
  assert.notEqual(classic.fg('rgb', 0x2e2c9b), 6, 'no blue text on blue');

  for (const [name, vic, rgbi] of [['green', [5, 13], [4, 5]], ['amber', [9, 8, 7], [12, 13]]]) {
    const v = palette('vic', name), c = palette('rgbi', name);
    for (let n = 0; n < 256; n++) {
      assert.ok(vic.includes(v.fg('palette', n)), `${name} C64 fg ${n}`);
      assert.ok(rgbi.includes(c.fg('palette', n)), `${name} C128 fg ${n}`);
    }
    assert.equal(v.screenBg, 0);
  }
  assert.ok(palette('vic', 'green').dimFg !== palette('vic', 'green').boldFg, 'dim differs from bold');
  assert.throws(() => palette('vic', 'plaid'), /unknown theme/);
  assert.deepEqual(THEME_NAMES, ['dark', 'light', 'classic', 'green', 'amber']);
});

test('a cell with both colours keeps the one covering most of it', async () => {
  const term = new xterm.Terminal({ cols: 40, rows: 25, allowProposedApi: true });
  // orange full block on black (Claude Code's logo), then black text on green
  await new Promise(done => term.write('\x1b[?25l\x1b[38;2;215;119;87;48;2;0;0;0m█\x1b[0m\x1b[30;42ma', done));
  const light = palette('vic', 'light');
  const { glyph, color } = snapshot(term, 0, DISPLAY.C64, 'light');
  assert.deepEqual([glyph[0], color[0]], [toScreenCode('█'), light.fg('rgb', 0xd77757)], 'block stays orange');
  assert.deepEqual([glyph[1], color[1]], [toScreenCode('a') ^ INVERSE, light.bg('palette', 2)], 'text becomes a green bar');
});

test('colour query replies', () => {
  const light = palette('vic', 'light');
  assert.equal(oscReply(11, '?', light), '\x1b]11;rgb:ffff/ffff/ffff\x1b\\');
  assert.equal(oscReply(10, '?', light), '\x1b]10;rgb:0000/0000/0000\x1b\\');
  assert.equal(oscReply(11, '?', VIC), '\x1b]11;rgb:0000/0000/0000\x1b\\');
  assert.equal(oscReply(4, '1;?;9;?', RGBI),
    '\x1b]4;1;rgb:aaaa/0000/0000\x1b\\\x1b]4;9;rgb:ffff/5555/5555\x1b\\');
  assert.equal(oscReply(11, 'rgb:0/0/0', VIC), null, 'setting a colour is not a query');
});

test('glyph mapping', () => {
  assert.equal(toScreenCode('a'), 1);
  assert.equal(toScreenCode('A'), 65);
  assert.equal(toScreenCode('╭'), 97);
  assert.equal(toScreenCode('⎿'), toScreenCode('└'));
  assert.equal(toScreenCode('█'), SPACE | INVERSE);
  assert.equal(toScreenCode('é'), toScreenCode('e'));
  assert.equal(toScreenCode('🦀'), toScreenCode('?'));
});

test('keymap', () => {
  const k = name => MATRIX.indexOf(name);
  assert.equal(keyToBytes(k('a'), 0), 'a');
  assert.equal(keyToBytes(k('a'), SHIFT), 'A');
  assert.equal(keyToBytes(k('c'), CTRL), '\x03');
  assert.equal(keyToBytes(k('p'), CBM), '\x1bp');
  assert.equal(keyToBytes(k('RETURN'), 0), '\r');
  assert.equal(keyToBytes(k('STOP'), 0), '\x1b');
  assert.equal(keyToBytes(k('CRSR↕'), SHIFT), '\x1b[A');
  assert.equal(keyToBytes(k('CRSR↕'), 0, { appCursor: true }), '\x1bOB');
  assert.equal(keyToBytes(k(':'), SHIFT), '[');
  assert.equal(keyToBytes(k('£'), 0), '\\');
  assert.deepEqual(keyToBytes(k('CRSR↔'), CBM), { pan: 1 });
  assert.deepEqual(keyToBytes(k('CRSR↔'), CBM | SHIFT), { pan: -1 });
  assert.deepEqual(keyToBytes(k('CRSR↕'), CTRL), { panY: 1 });
  assert.deepEqual(keyToBytes(k('CRSR↕'), CTRL | SHIFT), { panY: -1 });
});

test('C128 keys', () => {
  const k = name => MATRIX.indexOf(name);
  assert.equal(k('HELP'), 64);
  assert.equal(k('NOSCROLL'), 87);
  assert.equal(keyToBytes(k('ESC'), 0), '\x1b');
  assert.equal(keyToBytes(k('TAB'), 0), '\t');
  assert.equal(keyToBytes(k('TAB'), SHIFT), '\x1b[Z');
  assert.equal(keyToBytes(k('UP'), 0), '\x1b[A');
  assert.equal(keyToBytes(k('UP'), SHIFT), '\x1b[A', 'no SHIFT flip on the C128 cursor keys');
  assert.equal(keyToBytes(k('LEFT'), 0, { appCursor: true }), '\x1bOD');
  assert.deepEqual(keyToBytes(k('LEFT'), CBM), { pan: -1 });
  assert.deepEqual(keyToBytes(k('UP'), CTRL), { panY: -1 });
  assert.equal(keyToBytes(k('KP7'), 0), '7');
  assert.equal(keyToBytes(k('ENTER'), 0), '\r');
  assert.equal(keyToBytes(k('a'), ALT), '\x1ba');
  assert.equal(keyToBytes(k('ESC'), ALT), '\x1b\x1b');
  assert.equal(keyToBytes(k('NOSCROLL'), 0), null);
});

test('palettes', () => {
  assert.equal(RGBI.fg('palette', 1), 8, 'ANSI red = VDC dark red');
  assert.equal(RGBI.fg('palette', 12), 3, 'ANSI bright blue = VDC light blue');
  assert.equal(RGBI.bg('palette', 0), null);
  assert.equal(RGBI.fg('rgb', 0xd77757), 9, 'Claude orange');
  assert.equal(VIC.fg('palette', 1), 2, 'C64 mapping unchanged');
  assert.equal(VIC.fg('rgb', 0xb1b9f9), 14, 'Claude Code blue = C64 light blue');
  assert.equal(RGBI.fg('rgb', 0xb1b9f9), 3, 'Claude Code blue = VDC light blue');
  assert.notEqual(VIC.fg('rgb', 0xa0b0e8), 15, 'a pale blue is not grey');
  assert.equal(VIC.fg('rgb', 0x999999), 15, 'greys still map to grey');
});

test('snapshot of a terminal taller than the display', async () => {
  const term = new xterm.Terminal({ cols: 40, rows: 28, allowProposedApi: true });
  await new Promise(r => term.write(Array.from({ length: 28 }, (_, i) => `row ${i}`).join('\r\n'), r));
  const line = (s, y) => Array.from(s.glyph.slice(y * 40, y * 40 + 6), screenCodeToChar).join('');
  const top = snapshot(term, 0, DISPLAY.C64);
  assert.equal(top.rows, 25);
  assert.equal(line(top, 0), 'row 0 ');
  const bottom = snapshot(term, 0, DISPLAY.C64, 'dark', 3);
  assert.equal(line(bottom, 0), 'row 3 ');
  assert.equal(line(bottom, 24), 'row 27');
});

test('card suits keep their colour on a card', async () => {
  const term = new xterm.Terminal({ cols: 40, rows: 25, allowProposedApi: true });
  await new Promise(r => term.write('\x1b[30;47mA\x1b[31m♥\x1b[30m♠\x1b[0m', r));
  const dark = snapshot(term, 0, DISPLAY.C64, 'dark');
  assert.deepEqual([dark.glyph[0], dark.color[0]], [toScreenCode('A') | INVERSE, 15], 'text: inverse in the card colour');
  assert.deepEqual([dark.glyph[1], dark.color[1]], [toScreenCode('♥'), 2], 'red suit: red');
  assert.deepEqual([dark.glyph[2], dark.color[2]], [toScreenCode('♠') | INVERSE, 15], 'black suit: black shows through');
  const light = snapshot(term, 0, DISPLAY.C64, 'light');
  assert.deepEqual([light.glyph[1], light.color[1]], [toScreenCode('♥'), 2]);
  assert.deepEqual([light.glyph[2], light.color[2]], [toScreenCode('♠'), 0], 'black suit on a white screen: black');
});
