"""pettygame: hardware sprites and the SID for a program running in PETTY.

A program that runs on the host (over a pty, or ssh) and uses the C64 as its
screen, keyboard, sprite chip and sound chip prints escape sequences that the
bridge turns into C64 commands: OSC 8348 for sprites, OSC 8349 for the SID.
This module just prints them. See bridge/src/game.js for the whole story.

    import pettygame as pg
    pg.sprite_def(0, ["...###...", ...])        # 21 rows of up to 24 pixels
    pg.sprite(0, 0, x=160, y=100, color=7)      # sprite 0, shape 0
    pg.glide(0, dx=2, dy=0, frames=4)           # the C64 moves it, 2 pixels a frame
    s = pg.Script()
    s.rec([(0, 0x11), (1, 0x1C), (4, 0x11)], delay=8)   # registers, then wait 8 frames
    s.loop()
    pg.sid_def(1, s); pg.sid_play(0, 1, voices="1+2+vol")

Positions are pixels of the 320x200 text screen. Needs the C64 text client.
"""
import base64
import sys

PAL_HZ = 985248
NTSC_HZ = 1022727

# Sprite flags
WIDE, TALL, MULTICOLOUR, BEHIND = "x", "y", "m", "b"


def _osc(n, *parts):
    out = sys.stdout
    out.write("\x1b]%d;%s\x07" % (n, ";".join(str(p) for p in parts)))
    out.flush()


def _b64(data):
    return base64.b64encode(bytes(data)).decode("ascii")


# --- sprites -------------------------------------------------------------------

def shape(rows):
    """63 bytes from up to 21 rows of up to 24 characters: '#', 'X' or '1' is a pixel."""
    data = bytearray(63)
    for y, row in enumerate(rows[:21]):
        for x, ch in enumerate(row[:24]):
            if ch in "#X1":
                data[y * 3 + x // 8] |= 0x80 >> (x % 8)
    return bytes(data)


def sprite_def(slot, rows_or_bytes):
    """Shape slot 0-31 (kept in the C64). Rows as for shape(), or 63 bytes."""
    data = rows_or_bytes if isinstance(rows_or_bytes, (bytes, bytearray)) else shape(rows_or_bytes)
    _osc(8348, "def", slot, _b64(data))


def sprite(n, slot, x, y, color, flags=""):
    """Show sprite n (0-7) with a shape. Higher numbers are drawn behind lower ones."""
    _osc(8348, "set", n, slot, x, y, color, flags)


def hide(n):
    _osc(8348, "hide", n)


def glide(n, dx, dy, frames):
    """The C64 moves sprite n by (dx, dy) pixels each video frame for `frames` frames."""
    _osc(8348, "glide", n, dx, dy, frames)


def sprite_colors(c1, c2):
    """The two colours multicolour sprites share."""
    _osc(8348, "mc", c1, c2)


def sync(tag="1"):
    """Ask to be told when the glides have ended: the reply is on stdin, see Replies."""
    _osc(8348, "sync", tag)


class Replies:
    """Takes the bridge's replies (sync) out of what you read from stdin.

        r = Replies()
        keys = r.feed(os.read(0, 256))   # keys, with the replies removed
        r.tags                           # the tags of the syncs that have come back
    """

    START = b"\x1b]8348;"

    def __init__(self):
        self.tags = []
        self._buf = b""

    def feed(self, data):
        data = self._buf + data
        self._buf = b""
        out = b""
        while data:
            i = data.find(self.START)
            if i < 0:
                # a possible start of one at the end waits for the rest
                k = max((k for k in range(1, len(self.START)) if data.endswith(self.START[:k])), default=0)
                if k:
                    out, self._buf = out + data[:-k], data[-k:]
                else:
                    out += data
                break
            out += data[:i]
            j = data.find(b"\x07", i)
            if j < 0:
                self._buf = data[i:]
                break
            parts = data[i + 2:j].decode("ascii", "replace").split(";")
            if len(parts) >= 3 and parts[1] == "sync":
                self.tags.append(parts[2])
            data = data[j + 1:]
        return out


# --- the SID ---------------------------------------------------------------------

def freq(hz, pal=True):
    """The SID's 16-bit frequency value for a pitch in Hz."""
    return min(0xFFFF, round(hz * 16777216 / (PAL_HZ if pal else NTSC_HZ)))


def midi_hz(note):
    return 440.0 * 2 ** ((note - 69) / 12)


def voice_regs(voice):
    """The register numbers of voice 1-3: freq lo, hi, pulse lo, hi, control, attack/decay, sustain/release."""
    base = (voice - 1) * 7
    return tuple(range(base, base + 7))


class Script:
    """A SID script: records of register writes and the frames to wait after them."""

    def __init__(self):
        self.data = bytearray()
        self._ended = False

    def rec(self, writes, delay=0):
        """Write [(register, value), ...], then wait `delay` frames (0-255) before the next record."""
        if self._ended:
            raise ValueError("script has ended")
        if len(writes) > 252 or not 0 <= delay <= 255:
            raise ValueError("record too long, or bad delay")
        self.data.append(len(writes))
        for reg, val in writes:
            self.data += bytes((reg, val & 255))
        self.data.append(delay)
        return self

    def wait(self, frames):
        """Rest: the same as an empty record."""
        return self.rec([], frames)

    def mark(self):
        """Where a loop() goes back to (the start, without a mark)."""
        self.data.append(0xFD)
        return self

    def loop(self):
        self.data.append(0xFE)
        self._ended = True
        return self

    def end(self):
        self.data.append(0xFF)
        self._ended = True
        return self

    def bytes(self):
        return bytes(self.data)


def sid_def(script_id, script):
    """Upload a script (a Script, or its bytes) under an id 0-255."""
    _osc(8349, "def", script_id, _b64(script.bytes() if isinstance(script, Script) else script))


def sid_play(channel, script_id, voices="all"):
    """Start a script on channel 0-3. `voices` is where it may write: 1 2 3 f vol, joined by +."""
    _osc(8349, "play", channel, script_id, voices)


def sid_stop(channel="all"):
    _osc(8349, "stop", channel)


def sid_write(*pairs):
    """Write registers now: sid_write(24, 15, 4, 0x11)."""
    _osc(8349, "w", *pairs)


def sid_reset():
    _osc(8349, "reset")
