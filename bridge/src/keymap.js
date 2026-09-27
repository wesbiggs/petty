// C64 keyboard matrix codes (KERNAL $CB values) -> bytes for the pty.

export const SHIFT = 1, CBM = 2, CTRL = 4;

// Index = matrix code. Modifier keys never appear ($CB ignores them).
export const MATRIX = [
  'DEL', 'RETURN', 'RIGHT', 'F7', 'F1', 'F3', 'F5', 'DOWN',
  '3', 'w', 'a', '4', 'z', 's', 'e', 'LSHIFT',
  '5', 'r', 'd', '6', 'c', 'f', 't', 'x',
  '7', 'y', 'g', '8', 'b', 'h', 'u', 'v',
  '9', 'i', 'j', '0', 'm', 'k', 'o', 'n',
  '+', 'p', 'l', '-', '.', ':', '@', ',',
  '£', '*', ';', 'HOME', 'RSHIFT', '=', '↑', '/',
  '1', '←', 'CTRL', '2', 'SPACE', 'C=', 'q', 'STOP',
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
};

// C=+CRSR does what a trackpad swipe does in iTerm2: a mouse wheel event at
// mid-screen if the program tracks the mouse, arrows on the alternate screen,
// and otherwise { scroll } for the bridge to scroll its own scrollback.
// C=+CRSR→ returns { pan } to move the 40-column window over a wider terminal.
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

export function keyToBytes(code, mods, { appCursor = false, mouse = null } = {}) {
  const key = MATRIX[code];
  if (!key) return null;
  const shift = (mods & SHIFT) !== 0;

  if (key === 'DOWN' || key === 'RIGHT') {
    const dir = key === 'DOWN' ? (shift ? 'A' : 'B') : (shift ? 'D' : 'C');
    if (key === 'DOWN' && (mods & CBM)) return wheel(shift, mouse);
    if (key === 'RIGHT' && (mods & CBM)) return { pan: shift ? -1 : 1 };
    return ESC + (appCursor ? 'O' : '[') + dir;
  }
  if (SPECIAL[key]) return SPECIAL[key][shift ? 1 : 0];

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
