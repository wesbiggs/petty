// Characters from 128 up on an `ext` display, loaded with extended glyphs
// (extglyphs.js) as they appear on screen: 128-255 on the C64 hi-res screen,
// 128-511 on the C128 (bit 8 is the VDC's alternate character set attribute).
// A slot is reused, least recently shown first, once nothing on the new
// screen needs it; beyond that, the rest fall back to their aliases in the
// ordinary character set.
//
// Reloading a slot changes what the bridge's copy of the client's screen
// means: the C64's bitmap keeps the old pixels, and the C128 redraws the
// cells with the new glyph. Either way, those cells become unknown.

import { OP, VDC } from './protocol.js';
import { EXT, EXT_GLYPHS } from './extglyphs.js';
import { INVERSE } from './glyphs.js';
import { IMAGE } from './image.js';
import { FIXED } from './charset.js';

const isExt = g => g >= EXT && g < EXT + EXT_GLYPHS.length;

const ALT_SPACE = 256 + 32; // looks like a space to the encoder: never used

export class GlyphCache {
  // `reserved`: slots that --charset uses. `redrawn`: extended glyph -> 8 bytes, from --charset.
  constructor(display, reserved = [], redrawn = new Map()) {
    this.display = display;
    this.redrawn = redrawn;
    const last = display.hires ? 255 : 511;
    this.slots = [];
    for (let s = 128; s <= last; s++) if (s !== ALT_SPACE && !reserved.includes(s)) this.slots.push(s);
    this.slotOf = new Map(); // extended glyph -> slot
    this.glyphIn = new Map(); // slot -> extended glyph
    this.shown = new Map(); // slot -> frame last on screen
    this.frame = 0;
  }

  // Replaces extended glyphs in `want` with slots, and returns the GLYPH
  // commands that must precede the frame. Cells of `state` (the client's
  // screen, if known) that show a reloaded slot become unknown.
  place(want, state) {
    const { glyph, color } = want;
    // A --charset slot, 128-255, is already loaded: it only needs its number.
    for (let i = 0; i < glyph.length; i++) if (glyph[i] >= FIXED && glyph[i] < IMAGE) glyph[i] -= FIXED;
    const needed = new Set();
    for (const g of glyph) if (isExt(g)) needed.add(g);
    if (!needed.size) return [];
    this.frame++;

    const inUse = new Set();
    for (const g of needed) if (this.slotOf.has(g)) inUse.add(this.slotOf.get(g));
    const out = [];
    const assigned = new Map();
    for (const g of needed) {
      let slot = this.slotOf.get(g);
      if (slot === undefined) {
        slot = this.#free(inUse);
        if (slot === undefined) continue; // full: falls back below
        if (this.glyphIn.has(slot)) this.slotOf.delete(this.glyphIn.get(slot));
        this.glyphIn.set(slot, g);
        this.slotOf.set(g, slot);
        inUse.add(slot);
        out.push(OP.GLYPH, slot & 0xff, slot >> 8, ...(this.redrawn.get(g) ?? EXT_GLYPHS[g - EXT].data));
        if (state) this.#forget(state, slot);
      }
      this.shown.set(slot, this.frame);
      assigned.set(g, slot);
    }

    const alt = this.display.reverse; // the C128: bit 8 is an attribute
    for (let i = 0; i < glyph.length; i++) {
      const g = glyph[i];
      if (!isExt(g)) continue;
      let code = assigned.get(g);
      if (code === undefined) {
        // An inverse fallback (such as █) is its glyph in reverse.
        code = EXT_GLYPHS[g - EXT].fallback;
        if (code & INVERSE) {
          code ^= INVERSE;
          const c = color[i];
          color[i] = this.display.hires ? (c & ~0xFF) | (c & 15) << 4 | (c >> 4 & 15) : c ^ VDC.RVS;
        }
      }
      glyph[i] = code & 0xff;
      if (alt && code > 0xff) color[i] |= VDC.ALT;
    }
    return out;
  }

  #forget(state, slot) {
    const code = slot & 0xff, alt = slot > 0xff;
    for (let i = 0; i < state.glyph.length; i++) {
      if (state.glyph[i] !== code) continue;
      if (this.display.reverse && ((state.color[i] & VDC.ALT) !== 0) !== alt) continue;
      state.glyph[i] = -1;
    }
  }

  // An empty slot, else the one shown longest ago that this frame doesn't use.
  #free(inUse) {
    let best;
    for (const slot of this.slots) {
      if (inUse.has(slot)) continue;
      if (!this.glyphIn.has(slot)) return slot;
      if (best === undefined || this.shown.get(slot) < this.shown.get(best)) best = slot;
    }
    return best;
  }
}
