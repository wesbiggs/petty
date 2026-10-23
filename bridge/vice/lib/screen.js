// A client's screen, read from the emulated machine: compared with what the bridge's reference decoder
// (protocol.js Decoder) says it should be, or read back as text.
import { screenCodeToChar } from '../../src/glyphs.js';

// Where each client keeps its screen. A bitmap client's cell is checked by its pixels, from the client's own
// glyph tables, so a code drawn the same as another passes.
const LAYOUT = {
  // screen codes at $0400, colours (the low nibble) in colour RAM
  c64: { ranges: { ram: [0x0400, 0x07E7], io: [0xD800, 0xDBE7] }, cols: 40,
    cell: (m, i) => ({ code: m.ram[i], color: m.io[i] & 15 }) },
  // a code's 8 rows at $4000 + row * 256 + code, the bitmap at $6000, a colour byte per cell at $5C00
  hires: { ranges: { ram: [0x4000, 0x7FFF] }, cols: 40,
    rows: (m, i) => [...m.ram.subarray(0x2000 + i * 8, 0x2000 + i * 8 + 8)],
    glyph: (m, code) => Array.from({ length: 8 }, (_, r) => m.ram[r * 256 + code]),
    cell: (m, i) => ({ color: m.ram[0x1C00 + i] }) },
  // two characters to a bitmap cell: the left one's rows (high nibble) at $4000, the right one's at $4800
  soft80: { ranges: { ram: [0x4000, 0x7FFF] }, cols: 80,
    rows: (m, i) => [...m.ram.subarray(0x2000 + (i >> 1) * 8, 0x2000 + (i >> 1) * 8 + 8)].map(b => i & 1 ? b & 0x0F : b & 0xF0),
    glyph: (m, code, i) => Array.from({ length: 8 }, (_, r) => m.ram[(i & 1 ? 0x800 : 0) + r * 256 + code] & (i & 1 ? 0x0F : 0xF0)),
    cell: (m, i) => ({ color: m.ram[0x1C00 + (i >> 1)] >> 4 }) },
  // four 6-pixel characters to three bitmap cells; a code's rows, in the top 6 bits, at $2000 (the bitmap at $6000)
  soft53: { ranges: { ram: [0x2000, 0x7FFF] }, cols: 53,
    rows: (m, i) => {
      const y = Math.floor(i / 53), c = i % 53, cell = y * 40 + (c >> 2) * 3, shift = 18 - 6 * (c & 3);
      const byte = (k, r) => (c >> 2) * 3 + k < 40 ? m.ram[0x4000 + (cell + k) * 8 + r] : 0;
      return Array.from({ length: 8 }, (_, r) => (byte(0, r) << 16 | byte(1, r) << 8 | byte(2, r)) >> shift & 0x3F);
    },
    glyph: (m, code) => Array.from({ length: 8 }, (_, r) => m.ram[r * 256 + code] >> 2),
    cell: (m, i) => ({ color: m.ram[0x3C00 + Math.floor(i / 53) * 40 + ((i % 53) >> 2) * 3] >> 4 }) },
  // VDC RAM: screen codes at $0000, attribute bytes at $0800
  c128: { ranges: { vdc: [0x0000, 0x0FFF] }, cols: 80,
    cell: (m, i) => ({ code: m.vdc[i], color: m.vdc[0x800 + i] }) },
};

export async function readScreen(v) {
  const L = LAYOUT[v.client];
  const m = await v.dump(L.ranges);
  const cells = L.cols * 25;
  const half = i => v.client === 'soft80' ? i & 1 : 0; // the soft 80-column screen draws odd columns from another table
  // A bitmap client's codes, found by their pixels (the lowest code with them).
  let byPixels;
  const codeAt = i => {
    if (!L.rows) return L.cell(m, i).code;
    byPixels ??= [0, 1].map(h => { const map = new Map(); for (let c = 255; c >= 0; c--) map.set(L.glyph(m, c, h).join(), c); return map; });
    return byPixels[half(i)].get(L.rows(m, i).join()) ?? -1;
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
        if (L.rows) {
          const got = L.rows(m, i), exp = L.glyph(m, want, i);
          if (got.join() !== exp.join()) out.push(`${at}: pixels ${got} for code ${want} (${exp})`);
        } else if (L.cell(m, i).code !== want) out.push(`${at}: code ${L.cell(m, i).code}, not ${want}`);
        if (colors && L.cell(m, i).color !== (ref.color[i] & (v.client === 'c64' ? 15 : 255))) out.push(`${at}: colour ${L.cell(m, i).color}, not ${ref.color[i]}`);
      }
      return out;
    },
  };
}
