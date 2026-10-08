// Cell widths for the bridge's terminal.
//
// xterm's default (Unicode 6) counts every emoji as one cell, but the programs
// we host, and the terminals they are written for, draw them two cells wide.
// The mismatch shifts the rest of the line left of where the program thinks it
// is. This provider makes wide characters two cells: snapshot() shows the first
// as the unknown-character glyph (a middot) and the second, which has no
// characters of its own, as a space, so the line keeps its columns on the C64.
//
// Zero width: combining marks, variation selectors, joiners, format characters.
// A text-presentation symbol with U+FE0F (❤️) stays one cell, as xterm draws it.
// Parts of a ZWJ sequence (👨‍👩‍👧) are each their own two cells.

const ZERO = /^[\p{Mn}\p{Me}\p{Cf}]$/u;
const EMOJI = /^\p{Emoji_Presentation}$/u;
const WIDE = [
  [0x1100, 0x115F], [0x2E80, 0x303E], [0x3041, 0xA4CF], [0xAC00, 0xD7A3], [0xF900, 0xFAFF],
  [0xFE30, 0xFE6F], [0xFF00, 0xFF60], [0xFFE0, 0xFFE6], [0x20000, 0x3FFFD],
];

export function wcwidth(cp) {
  if (cp < 0x300) return cp < 0x20 || (cp >= 0x7F && cp < 0xA0) ? 0 : 1;
  const ch = String.fromCodePoint(cp);
  if (ZERO.test(ch) || (cp >= 0x1F3FB && cp <= 0x1F3FF)) return 0; // skin tones
  if (cp >= 0x1100 && (EMOJI.test(ch) || WIDE.some(([a, b]) => cp >= a && cp <= b))) return 2;
  return 1;
}

// xterm's IUnicodeVersionProvider; `preceding` is the property of the previous
// character, whose width a joined character takes if larger (bit 1-2).
const provider = {
  version: 'petty',
  wcwidth,
  charProperties(cp, preceding) {
    let width = wcwidth(cp);
    let join = width === 0 && preceding !== 0;
    if (join) {
      const before = (preceding >> 1) & 3;
      if (!before) join = false; else if (before > width) width = before;
    }
    return (width & 3) << 1 | (join ? 1 : 0);
  },
};

// Use on a Terminal made with allowProposedApi.
export function wideEmoji(term) {
  term.unicode.register(provider);
  term.unicode.activeVersion = provider.version;
}
