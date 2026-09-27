// Keyboard matrix codes (C64 KERNAL $CB, C128 $D4) -> bytes for the pty.

export const SHIFT = 1, CBM = 2, CTRL = 4, ALT = 8; // ALT: C128 only

// Index = matrix code. Modifier keys never appear (the KERNAL ignores them).
// 64-87 are the C128's extra keys; KP = numeric keypad.
export const MATRIX = [
  'DEL', 'RETURN', 'CRSR↔', 'F7', 'F1', 'F3', 'F5', 'CRSR↕',
  '3', 'w', 'a', '4', 'z', 's', 'e', 'LSHIFT',
  '5', 'r', 'd', '6', 'c', 'f', 't', 'x',
  '7', 'y', 'g', '8', 'b', 'h', 'u', 'v',
  '9', 'i', 'j', '0', 'm', 'k', 'o', 'n',
  '+', 'p', 'l', '-', '.', ':', '@', ',',
  '£', '*', ';', 'HOME', 'RSHIFT', '=', '↑', '/',
  '1', '←', 'CTRL', '2', 'SPACE', 'C=', 'q', 'STOP',
  'HELP', 'KP8', 'KP5', 'TAB', 'KP2', 'KP4', 'KP7', 'KP1',
  'ESC', 'KP+', 'KP-', 'LINEFEED', 'ENTER', 'KP6', 'KP9', 'KP3',
  'ALT', 'KP0', 'KP.', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'NOSCROLL',
];

const ESC = '\x1b';

// [unshifted, shifted, commodore] for printable keys. Follows the C64
// keycap legends, with the missing ASCII characters on nearby keys.
const PRINTABLE = {
  '1': ['1', '!'], '2': ['2', '"'], '3': ['3', '#'], '4': ['4', '$'], '5': ['5', '%'],
  '6': ['6', '&'], '7': ['7', "'"], '8': ['8', '('], '9': ['9', ')'], '0': ['0', '0'],
  '+': ['+', '+'], '-': ['-', '_'], '£': ['\\', '|', '|'], '@': ['@', '`', '`'],
  '*': ['*', '*', '~'], '↑': ['^', '~', '~'], ':': [':', '[', '{'], ';': [';', ']', '}'],
  '=': ['=', '='], ',': [',', '<'], '.': ['.', '>'], '/': ['/', '?'], 'SPACE': [' ', ' ', ' '],
};

// [unshifted, shifted]; `null` = nothing.
const SPECIAL = {
  RETURN: ['\r', ESC + '\r'], // shift+RETURN = meta+enter = newline in Claude Code
  DEL: ['\x7f', ESC + '[3~'],
  HOME: [ESC + '[H', '\x0c'], // CLR = ctrl+L (redraw)
  STOP: [ESC, '\x03'], // RUN/STOP = Esc, shift = ctrl+C
  '←': [ESC, '_'],
  F1: [ESC + '[Z', ESC + '[5~'], // F1 shift+tab (mode), F2 page up
  F3: ['\t', ESC + '[6~'], // F3 tab, F4 page down
  F5: ['\x12', null], // ctrl+R history search
  F7: ['\x0f', null], // ctrl+O transcript
  // C128
  ESC: [ESC, ESC],
  TAB: ['\t', ESC + '[Z'],
  LINEFEED: ['\n', '\n'], // ctrl+J = newline in Claude Code
  HELP: [ESC + 'OP', ESC + 'OP'], // F1
  ENTER: ['\r', '\r'],
};

// C=+CRSR does what a trackpad swipe does in iTerm2: a mouse wheel event at
// mid-screen if the program tracks the mouse, arrows on the alternate screen,
// and otherwise { scroll } for the bridge to scroll its own scrollback.
// C=+CRSR→ returns { pan } to move the 40-column window over a wider terminal,
// and CTRL+CRSR↓ { panY } to move the 25-row window over a taller one.
// C=+F1 returns { theme } to switch to the next (SHIFT: previous) theme.
const WHEEL_COL = 20, WHEEL_ROW = 12, WHEEL_LINES = 3;
function wheel(up, mouse) {
  const button = up ? 64 : 65;
  if (!mouse || mouse.tracking === 'none') {
    if (mouse?.altScreen) return ESC + '[' + (up ? 'A' : 'B');
    return { scroll: up ? -WHEEL_LINES : WHEEL_LINES };
  }
  if (mouse.encoding === 'SGR') return `${ESC}[<${button};${WHEEL_COL};${WHEEL_ROW}M`;
  return ESC + '[M' + String.fromCharCode(32 + button, 32 + WHEEL_COL, 32 + WHEEL_ROW);
}

const ARROW = { UP: 'A', DOWN: 'B', RIGHT: 'C', LEFT: 'D' };

// ALT (C128) sends Meta: Esc before whatever the key sends.
export function keyToBytes(code, mods, opts) {
  const bytes = keyToBytesNoAlt(code, mods, opts);
  return (mods & ALT) && typeof bytes === 'string' ? ESC + bytes : bytes;
}

function keyToBytesNoAlt(code, mods, { appCursor = false, mouse = null } = {}) {
  let key = MATRIX[code];
  if (!key) return null;
  const shift = (mods & SHIFT) !== 0;

  // The C64's two CRSR keys use SHIFT for up and left; the C128's four
  // cursor keys don't. C= turns up/down into scrolling, left/right into panning;
  // CTRL turns up/down into panning.
  if (key === 'CRSR↕') key = shift ? 'UP' : 'DOWN';
  if (key === 'CRSR↔') key = shift ? 'LEFT' : 'RIGHT';
  if (ARROW[key]) {
    if ((mods & CTRL) && (key === 'UP' || key === 'DOWN')) return { panY: key === 'DOWN' ? 1 : -1 };
    if (mods & CBM) {
      if (key === 'UP' || key === 'DOWN') return wheel(key === 'UP', mouse);
      return { pan: key === 'RIGHT' ? 1 : -1 };
    }
    return ESC + (appCursor ? 'O' : '[') + ARROW[key];
  }
  if (key === 'F1' && (mods & CBM)) return { theme: shift ? -1 : 1 };
  if (SPECIAL[key]) return SPECIAL[key][shift ? 1 : 0];
  if (key.startsWith('KP')) return key.slice(2);

  if (key.length === 1 && key >= 'a' && key <= 'z') {
    if (mods & CTRL) return String.fromCharCode(key.charCodeAt(0) & 0x1f);
    if (mods & CBM) return ESC + key; // meta
    return shift ? key.toUpperCase() : key;
  }

  const p = PRINTABLE[key];
  if (!p) return null;
  if (mods & CBM) return p[2] ?? p[0];
  return shift ? p[1] : p[0];
}
