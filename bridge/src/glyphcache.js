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
import { INVERSE, SPACE } from './glyphs.js';
import { IMAGE, vdcCell } from './image.js';
import { FIXED } from './charset.js';

const isExt = g => g >= EXT && g < EXT + EXT_GLYPHS.length;
const lit = bits => bits.reduce((n, b) => n + [...b.toString(2)].filter(d => d === '1').length, 0);

const ALT_SPACE = 256 + 32; // looks like a space to the encoder: never used

export class GlyphCache {
  // `reserved`: slots that --charset uses. `redrawn`: extended glyph -> 8 bytes, from --charset.
  constructor(display, reserved, redrawn) {
    reserved ??= []; // null without --charset: a default parameter would not catch it
    redrawn ??= new Map();
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
  // screen, if known) that show a reloaded slot become unknown. On the C128,
  // inline image cells (glyphs from IMAGE up, image.js vdcCell) get slots
  // too, one for each different cell; when there are none left, they are
  // blocks.
  place(want, state) {
    const { glyph, color } = want;
    // A --charset slot, 128-255, is already loaded: it only needs its number.
    for (let i = 0; i < glyph.length; i++) if (glyph[i] >= FIXED && glyph[i] < IMAGE) glyph[i] -= FIXED;
    const image = g => this.display.reverse && g >= IMAGE;
    // What a slot holds: an extended glyph's number, or an image cell's pixels.
    const idOf = g => (image(g) ? `image ${vdcCell(g - IMAGE).bits.join(',')}` : g);
    const needed = new Map(); // id -> its 8 bytes
    for (const g of glyph) {
      if (image(g)) needed.set(idOf(g), vdcCell(g - IMAGE).bits);
      else if (isExt(g)) needed.set(g, this.redrawn.get(g) ?? EXT_GLYPHS[g - EXT].data);
    }
    if (!needed.size) return [];
    this.frame++;

    const inUse = new Set();
    for (const id of needed.keys()) if (this.slotOf.has(id)) inUse.add(this.slotOf.get(id));
    const out = [];
    const assigned = new Map();
    for (const [id, data] of needed) {
      let slot = this.slotOf.get(id);
      if (slot === undefined) {
        slot = this.#free(inUse);
        if (slot === undefined) continue; // full: falls back below
        if (this.glyphIn.has(slot)) this.slotOf.delete(this.glyphIn.get(slot));
        this.glyphIn.set(slot, id);
        this.slotOf.set(id, slot);
        inUse.add(slot);
        out.push(OP.GLYPH, slot & 0xff, slot >> 8, ...data);
        if (state) this.#forget(state, slot);
      }
      this.shown.set(slot, this.frame);
      assigned.set(id, slot);
    }

    const alt = this.display.reverse; // the C128: bit 8 is an attribute
    for (let i = 0; i < glyph.length; i++) {
      const g = glyph[i];
      if (!isExt(g) && !image(g)) continue;
      let code = assigned.get(idOf(g));
      if (code === undefined) {
        // An inverse fallback (such as █) is its glyph in reverse; an image cell is a block, lit if mostly lit.
        code = image(g) ? SPACE | (lit(vdcCell(g - IMAGE).bits) >= 32 ? INVERSE : 0) : EXT_GLYPHS[g - EXT].fallback;
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
