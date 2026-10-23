// A client's screen, read from the emulated machine: compared with what the bridge's reference decoder
// (protocol.js Decoder) says it should be, or read back as text.
import { screenCodeToChar } from '../../src/glyphs.js';
import { FONT4 } from '../../src/font4x8.js';
import { FONT6 } from '../../src/font6x8.js';

// The C64 client keeps every screen's memory in the VIC's second bank: cell colours (and the text screen's codes) at
// $5C00, the bitmap at $6000, the hi-res font at $4000. Its soft screens build their glyph tables under BASIC's ROM
// ($A000-$BFFF, and $4000 and $C100 at 53 columns); those are not read back here. A soft screen's pixels are checked
// against the bridge's own font instead, as bridge/scripts/vice-screen-check.js checks them.
const COLRAM = 0x5C00, BITMAP = 0x6000;

// Row r of a character cell, as its font holds it: `width` pixels of the hi-res bitmap, MSB first.
const fromBitmap = (width, cols) => (m, i, r, at) => {
  const y = Math.floor(i / cols), x0 = (i % cols) * width;
  let v = 0;
  for (let b = 0; b < width; b++) { const x = x0 + b; v = v << 1 | (m.ram[at + y * 320 + (x >> 3) * 8 + r] >> (7 - (x & 7)) & 1); }
  return v;
};

// A screen code's rows in one of the bridge's soft-screen fonts; 128-255 are the inverse of 0-127.
// Takes the machine too, unused, so it stands in for a LAYOUT's own `glyph`.
const fromFont = (FONT, width) => (m, code) => {
  const rows = FONT[code & 127], mask = (1 << width) - 1;
  return code & 128 ? rows.map(b => ~b & mask) : [...rows];
};

const LAYOUT = {
  // screen codes at $5C00, colours (the low nibble) in colour RAM
  c64: { ranges: { ram: [COLRAM, COLRAM + 0x3E7], io: [0xD800, 0xDBE7] }, cols: 40, colorMask: 15,
    cell: (m, i) => ({ code: m.ram[i], color: m.io[i] & 15 }) },
  // a code's 8 rows at $4000 + r * 256 + code, the bitmap at $6000, a colour byte a cell at $5C00
  hires: { ranges: { ram: [0x4000, 0x7FFF] }, cols: 40, colorMask: 255,
    rows: (m, i) => [...m.ram.subarray(BITMAP - 0x4000 + i * 8, BITMAP - 0x4000 + i * 8 + 8)],
    glyph: (m, code) => Array.from({ length: 8 }, (_, r) => m.ram[r * 256 + code]),
    cell: (m, i) => ({ color: m.ram[COLRAM - 0x4000 + i] }) },
  // two characters to a bitmap cell, four pixels each; the cell's colour (the high nibble) is its group's
  soft80: { ranges: { ram: [COLRAM, 0x7F3F] }, cols: 80, colorMask: 15, width: 4, font: FONT4,
    cell: (m, i) => ({ color: m.ram[(i >> 1)] >> 4 }) },
  // four six-pixel characters to three bitmap cells, which share a colour
  soft53: { ranges: { ram: [COLRAM, 0x7F3F] }, cols: 53, colorMask: 15, width: 6, font: FONT6,
    cell: (m, i) => ({ color: m.ram[Math.floor(i / 53) * 40 + ((i % 53) >> 2) * 3] >> 4 }) },
  // VDC RAM: screen codes at $0000, attribute bytes at $0800
  c128: { ranges: { vdc: [0x0000, 0x0FFF] }, cols: 80, colorMask: 255,
    cell: (m, i) => ({ code: m.vdc[i], color: m.vdc[0x800 + i] }) },
};

export async function readScreen(v) {
  const L = LAYOUT[v.client];
  const m = await v.dump(L.ranges);
  const cells = L.cols * 25;
  // The soft screens read their pixels out of the bitmap and compare them with the bridge's font.
  const rows = L.rows ?? (L.width ? (() => { const f = fromBitmap(L.width, L.cols); return (mm, i) => Array.from({ length: 8 }, (_, r) => f(mm, i, r, BITMAP - COLRAM)); })() : null);
  const glyph = L.glyph ?? (L.font ? fromFont(L.font, L.width) : null);

  // A bitmap screen's codes, found by their pixels (the lowest code with them).
  let byPixels;
  const codeAt = i => {
    if (!rows) return L.cell(m, i).code;
    byPixels ??= (() => { const map = new Map(); for (let c = 255; c >= 0; c--) map.set(glyph(m, c).join(), c); return map; })();
    return byPixels.get(rows(m, i).join()) ?? -1;
  };
  return {
    cols: L.cols,
    // The screen as lines of text (the lowercase character set), ? for what is not a code.
    lines() {
      const out = [];
      for (let r = 0; r < 25; r++) {
        let s = '';
        for (let c = 0; c < L.cols; c++) { const code = codeAt(r * L.cols + c); s += code < 0 ? '?' : screenCodeToChar(code & 127); }
        out.push(s);
      }
      return out;
    },
    // Where the screen differs from a Decoder's, up to `max` of them. `colors`: false skips colours.
    differences(ref, { colors = true, max = 10 } = {}) {
      const out = [];
      for (let i = 0; i < cells && out.length < max; i++) {
        const at = `row ${Math.floor(i / L.cols)} column ${i % L.cols}`;
        const want = ref.glyph[i];
        if (rows) {
          const got = rows(m, i), exp = glyph(m, want);
          if (got.join() !== exp.join()) out.push(`${at}: pixels ${got} for code ${want} (${exp})`);
        } else if (L.cell(m, i).code !== want) out.push(`${at}: code ${L.cell(m, i).code}, not ${want}`);
        if (colors && L.cell(m, i).color !== (ref.color[i] & L.colorMask)) out.push(`${at}: colour ${L.cell(m, i).color}, not ${ref.color[i] & L.colorMask}`);
      }
      return out;
    },
  };
}
