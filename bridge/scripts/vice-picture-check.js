// Runs the C64 client (build/petty.prg) in VICE on each of its screens, and shows full-screen pictures there, as
// petty-view does: a multicolour one (Koala) and a hi-res one (Art Studio); on the soft screens, also inline image
// cells (CELLS, for imgcat) and underline. Checks the VIC's set-up and the picture's memory while it shows, that the
// sprites are hidden and come back, and that VIEW TERMINAL gives the terminal screen back. This script is the
// bridge. Needs x64sc. --shots DIR: screenshots there, one of each picture on each screen.
//
// usage: node scripts/vice-picture-check.js [--keep] [--shots DIR] [prg]
import { copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { MSG, OP, VIEW, DISPLAY, encodePicture, encodeReset, encodeSprDef, encodeSpr } from '../src/protocol.js';
import { toKoala, toHiresPicture } from '../src/image.js';
import { startVice, checks, sleep } from './vice.js';

const { values: opt, positionals } = parseArgs({ allowPositionals: true, options: { keep: { type: 'boolean', default: false }, shots: { type: 'string' } } });
const prg = resolve(positionals[0] ?? fileURLToPath(new URL('../../build/petty.prg', import.meta.url)));
const log = (...a) => console.error('[vice-picture]', ...a);
const { check, done } = checks(log);

// A picture to show: bands of colour with a circle, so a screenshot shows whether it is right.
const img = { width: 320, height: 200, rgba: new Uint8Array(320 * 200 * 4) };
for (let y = 0; y < 200; y++) {
  for (let x = 0; x < 320; x++) {
    const inCircle = (x - 160) ** 2 + (y - 100) ** 2 < 70 ** 2;
    const rgb = inCircle ? [255, 220, 40] : [x * 0.8, y * 1.2, 255 - x * 0.7];
    img.rgba.set([...rgb.map(v => Math.max(0, Math.min(255, Math.round(v)))), 255], (y * 320 + x) * 4);
  }
}
const KOALA = toKoala(img);
const HIRES = { ...toHiresPicture(img, { type: 'flat' }), bg: 6 };

// The terminal screen each screen goes back to: $D011, $D018 (bit 0 reads as 1), the VIC's bank (CIA 2 port A bits 0-1).
const CLIENTS = [DISPLAY.C64, DISPLAY.C64_HIRES, DISPLAY.C64_80, DISPLAY.C64_53].map(d => ({
  name: d.key, display: d, term: d === DISPLAY.C64 ? [0x1B, 0x71, 2] : [0x3B, 0x79, 2],
}));

const vicOf = io => [io[0x11] & 0x7F, io[0x16], io[0x18], io[0xD00] & 3];
const same = (got, want, what) => {
  const i = got.findIndex((v, k) => v !== want[k]);
  if (i >= 0) throw new Error(`${what}: byte ${i} is ${got[i]}, not ${want[i]}`);
};

for (const client of CLIENTS) {
  const c = await startVice(prg, { keep: opt.keep || !!opt.shots, log });
  const shot = async name => {
    if (!opt.shots) return;
    await c.monitor([`screenshot "${name}.bmp" 0`]);
    await sleep(300);
    copyFileSync(join(c.work, `${name}.bmp`), join(opt.shots, `${client.name.replace(/ /g, '-')}-${name}.bmp`));
  };
  try {
    await check(`${client.name}: it starts`, async () => {
      await c.read(4, 'HELLO_ON and MODES');
      c.sock.write(Buffer.from([OP.MODE, client.display.id]));
      assert.deepEqual((await c.read(4, 'HELLO_ON')).slice(0, 2), [MSG.HELLO_ON, client.display.id]);
      const want = { cols: client.display.cols, rows: client.display.rows, hires: client.display.hires };
      want.glyph = new Int32Array(want.cols * want.rows).map((_, i) => 1 + i % 26);
      want.color = new Int16Array(want.cols * want.rows).fill(client.display.hires ? 0x10 : 1);
      await c.frame(encodeReset(want).bytes);
      // A sprite of the game's, which a picture hides.
      await c.frame([...encodeSprDef(0, new Array(63).fill(255)), ...encodeSpr(1, 0, 2, 2, 100, 100), OP.FRAME]);
    });

    if (client.display.images && !client.display.hires) await check(`${client.name}: inline image cells (CELLS), the text around them kept`, async () => {
      const data = n => Array.from({ length: n * 9 }, (_, k) => (k * 37 + n) & 255);
      const runs = [[3, 5, 4], [24, 36, 4], [10, 0, 1]]; // row, cell, n: one at the end of the last row
      const before = await c.machine();
      for (const [row, cell, n] of runs) await c.frame([OP.CELLS, row, cell, n, ...data(n), OP.FRAME]);
      const { ram } = await c.machine();
      const bits = [...before.ram.subarray(0x6000, 0x6000 + 8000)], cols = [...before.ram.subarray(0x5C00, 0x5C00 + 1000)];
      for (const [row, cell, n] of runs) {
        const d = data(n);
        for (let k = 0; k < n; k++) {
          const at = row * 40 + cell + k;
          bits.splice(at * 8, 8, ...d.slice(k * 9, k * 9 + 8));
          cols[at] = d[k * 9 + 8];
        }
      }
      same([...ram.subarray(0x6000, 0x6000 + 8000)], bits, 'bitmap');
      same([...ram.subarray(0x5C00, 0x5C00 + 1000)], cols, 'colours');
    });

    if (client.display.underline) await check(`${client.name}: UNDERLINE sets the bottom row of what is written, in its own pixels`, async () => {
      // "a" underlined, then "b" and "c" not: at 80 columns a and b share cell 0, c is in cell 1; at 53, a is
      // cell 0's first 6 pixels, b its last 2 and cell 1's first 4, c cell 1's next 4 and cell 2's first 2.
      await c.frame([OP.COLOR, 1, OP.GOTO, 20, 0, OP.UNDERLINE, 1, OP.PUT, 1, 1, OP.UNDERLINE, 0, OP.PUT, 2, 2, 3, OP.FRAME]);
      const { ram } = await c.machine();
      const row7 = cell => ram[0x6000 + 20 * 320 + cell * 8 + 7];
      if (client.display.pair) {
        assert.equal(row7(0) & 0xF0, 0xF0, 'a underlined');
        assert.equal(row7(0) & 0x0F, 0, 'b not');
        assert.equal(row7(1), 0, 'c not');
      } else {
        assert.equal(row7(0) & 0xFC, 0xFC, 'a underlined');
        assert.equal(row7(0) & 0x03, 0, 'b not');
        assert.equal(row7(1), 0, 'b and c not');
      }
    });

    for (const [kind, pic] of [['multicolour', KOALA], ['hi-res', HIRES]]) {
      await check(`${client.name}: a ${kind} picture full screen, then the terminal back`, async () => {
        for (const f of encodePicture(pic, 2048)) await c.frame(f);
        let { io, ram } = await c.machine();
        assert.deepEqual(vicOf(io), [0x3B, pic.hires ? 0xC8 : 0xD8, 0x79, 2], 'the VIC shows the picture');
        assert.equal(io[0x15], 0, 'no sprites over it');
        assert.equal(io[0x20] & 15, pic.bg, 'border');
        same([...ram.subarray(0x6000, 0x6000 + 8000)], [...pic.bitmap], 'bitmap');
        same([...ram.subarray(0x5C00, 0x5C00 + 1000)], [...pic.screen], 'screen colours');
        if (!pic.hires) same([...io.subarray(0x800, 0x800 + 1000)].map(v => v & 15), [...pic.colram].map(v => v & 15), 'colour RAM');
        await shot(kind);
        await c.frame([OP.VIEW, VIEW.TERMINAL, 0, OP.FRAME]);
        ({ io } = await c.machine());
        assert.deepEqual(vicOf(io), [client.term[0], 0xC8, client.term[1], client.term[2]], 'the terminal screen');
        assert.equal(io[0x15] & 2, 2, 'the sprite is back');
      });
    }
  } finally { c.stop(); }
}
done();
