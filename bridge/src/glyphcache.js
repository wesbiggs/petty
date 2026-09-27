// The hi-res client's screen codes 128-255, loaded with extended glyphs
// (extglyphs.js) as they appear on screen. A slot is reused, least recently
// shown first, once nothing on the new screen needs it; the client's bitmap
// keeps the old pixels, so only the bridge's idea of which cells show that
// code has to be forgotten. Beyond 128 different glyphs on one screen, the
// rest fall back to their aliases in the ordinary character set.

import { OP } from './protocol.js';
import { EXT, EXT_GLYPHS } from './extglyphs.js';

const FIRST = 128, SLOTS = 128;

export class GlyphCache {
  constructor() {
    this.slotOf = new Map(); // extended glyph -> slot
    this.glyphIn = new Array(SLOTS).fill(null); // slot - FIRST -> extended glyph
    this.shown = new Array(SLOTS).fill(0); // slot - FIRST -> frame last on screen
    this.frame = 0;
  }

  // Replaces extended glyphs in `want.glyph` with slots, and returns the GLYPH
  // commands that must precede the frame. Cells of `state` (the client's
  // screen, if known) that show a redefined slot become unknown.
  place(want, state) {
    const { glyph } = want;
    const needed = new Set();
    for (const g of glyph) if (g >= EXT) needed.add(g);
    if (!needed.size) return [];
    this.frame++;

    const inUse = new Set();
    for (const g of needed) {
      const slot = this.slotOf.get(g);
      if (slot !== undefined) inUse.add(slot);
    }
    const out = [];
    const assigned = new Map();
    for (const g of needed) {
      let slot = this.slotOf.get(g);
      if (slot === undefined) {
        slot = this.#free(inUse);
        if (slot === undefined) continue; // full: falls back below
        const old = this.glyphIn[slot - FIRST];
        if (old !== null) this.slotOf.delete(old);
        this.glyphIn[slot - FIRST] = g;
        this.slotOf.set(g, slot);
        inUse.add(slot);
        out.push(OP.GLYPH, slot, ...EXT_GLYPHS[g - EXT].data);
        if (state) for (let i = 0; i < state.glyph.length; i++) if (state.glyph[i] === slot) state.glyph[i] = -1;
      }
      this.shown[slot - FIRST] = this.frame;
      assigned.set(g, slot);
    }
    for (let i = 0; i < glyph.length; i++) {
      const g = glyph[i];
      if (g < EXT) continue;
      const slot = assigned.get(g);
      if (slot !== undefined) { glyph[i] = slot; continue; }
      // An inverse fallback (such as █) is its glyph with the colours swapped.
      const code = EXT_GLYPHS[g - EXT].fallback, c = want.color[i];
      glyph[i] = code & 0x7f;
      if (code & 0x80) want.color[i] = (c & 15) << 4 | c >> 4;
    }
    return out;
  }

  // An empty slot, else the one shown longest ago that this frame doesn't use.
  #free(inUse) {
    let best;
    for (let k = 0; k < SLOTS; k++) {
      const slot = FIRST + k;
      if (inUse.has(slot)) continue;
      if (this.glyphIn[k] === null) return slot;
      if (best === undefined || this.shown[k] < this.shown[best - FIRST]) best = slot;
    }
    return best;
  }
}
