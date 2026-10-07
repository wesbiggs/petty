#!/usr/bin/env python3
"""A small game on the C64 with all the logic on the host: a hero sprite walks
over a scrolling map, shoots arrows (SPACE), and a tune plays. Arrow keys
walk, SPACE shoots, M turns the music off and on, Q quits.

    make bridge CMD="-- python3 bridge/examples/game-demo.py"

With --auto it walks by itself (for looking at it without a keyboard).
"""
import os
import random
import select
import sys
import termios
import tty

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
import pettygame as pg  # noqa: E402

W, H = 80, 60           # the world, in cells
VW, VH = 40, 24         # what the C64 shows of it
HERO_SLOT, ARROW_SLOT = 0, 1
CELL = 8

random.seed(7)
world = [["." for _ in range(W)] for _ in range(H)]
for _ in range(400):
    x, y = random.randrange(W), random.randrange(H)
    world[y][x] = random.choice('"""#~')
TERRAIN = {
    ".": "\x1b[32m.",
    '"': "\x1b[92m\"",
    "#": "\x1b[90m#",
    "~": "\x1b[94m~"
}

HERO = [
    "",
    "",
    "",
    "      ####",
    "     ######",
    "     ######",
    "      ####",
    "     ######",
    "    ########",
    "    ## ## ##",
    "    ########",
    "     ######",
    "     ######",
    "     ##  ##",
    "     ##  ##",
    "     ##  ##"
]

ARROW = ["", "", "", "", "", "", "", "", "", "", "########>"]


def tune():
    """C major pentatonic, two voices: a triangle melody and a quiet pulse bass."""
    s = pg.Script()
    s.rec([(5, 0x09), (6, 0xA9), (12, 0x09), (13, 0x98), (9, 0), (10, 8), (24, 15)], 1)
    melody = [60, 64, 67, 72, 67, 64, 60, 62, 64, 67, 69, 67, 64, 62, 60, 55]
    for i, n in enumerate(melody):
        f = pg.freq(pg.midi_hz(n))
        s.rec([(4, 0x10)], 1)
        s.rec([(0, f & 255), (1, f >> 8), (4, 0x11)], 7)
        if i % 4 == 0:
            b = pg.freq(pg.midi_hz(n - 24))
            s.rec([(11, 0x40), (7, b & 255), (8, b >> 8), (11, 0x41)], 0)
    return s.loop()


STEP = pg.Script().rec([(19, 0x00), (20, 0xA0), (15, 0x10), (18, 0x81)], 2).rec([(18, 0x80)], 0).end()
SHOT = (pg.Script().rec([(19, 0x00), (20, 0xF0), (14, 0), (15, 0x30), (18, 0x41)], 1)
        .rec([(15, 0x20)], 1).rec([(15, 0x10)], 1).rec([(15, 0x08)], 2).rec([(18, 0x40)], 0).end())


def draw(cx, cy, hud):
    out = ["\x1b[H"]
    for y in range(VH):
        out.append("".join(TERRAIN[world[cy + y][cx + x]] for x in range(VW)))
        if y < VH - 1:
            out.append("\r\n")
    out.append("\x1b[25;1H\x1b[97m%-39s" % hud)
    sys.stdout.write("".join(out))
    sys.stdout.flush()


def main():
    auto = "--auto" in sys.argv
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    tty.setcbreak(fd)
    sys.stdout.write("\x1b[?25l\x1b[2J")
    pg.sprite_def(HERO_SLOT, HERO)
    pg.sprite_def(ARROW_SLOT, ARROW)
    pg.sid_def(1, tune())
    pg.sid_def(2, STEP)
    pg.sid_def(3, SHOT)
    music = True
    pg.sid_play(0, 1, "1+2+vol")

    hx, hy = 20, 12            # the hero's cell on the screen
    cx, cy = 20, 20            # the camera: the world cell at the top left
    facing = (1, 0)
    replies = pg.Replies()
    script = iter(([(1, 0)] * 14 + [(0, 1)] * 10 + [(-1, 0)] * 14 + [(0, -1)] * 10) * 4) if auto else None
    pg.sprite(0, HERO_SLOT, hx * CELL, hy * CELL - 8, 7)
    draw(cx, cy, "arrows walk, space shoots, m music, q quit")
    busy = 0
    try:
        while True:
            r, _, _ = select.select([fd], [], [], 0.02 if not auto else 0.0)
            key = b""
            if r:
                key = replies.feed(os.read(fd, 64))
            move = None
            if auto:
                if busy:
                    busy -= 1
                    select.select([], [], [], 0.02)
                    continue
                move = next(script, None)
                if move is None:
                    break
                busy = 8
            elif key in (b"q", b"Q"):
                break
            elif key in (b"m", b"M"):
                music = not music
                pg.sid_play(0, 1, "1+2+vol") if music else pg.sid_stop(0)
            elif key == b" ":
                pg.sprite(1, ARROW_SLOT, hx * CELL + facing[0] * 8, hy * CELL + facing[1] * 8 + 2, 5)
                pg.glide(1, facing[0] * 8, facing[1] * 8, 12)
                pg.sid_play(1, 3, "3")
            else:
                move = {b"\x1b[A": (0, -1), b"\x1b[B": (0, 1), b"\x1b[C": (1, 0), b"\x1b[D": (-1, 0)}.get(key)
            if move:
                facing = move
                nx, ny = hx + move[0], hy + move[1]
                wx, wy = cx + nx, cy + ny
                if not (0 <= wx < W and 0 <= wy < H) or world[wy][wx] in "#~":
                    continue
                pg.sid_play(1, 2, "3")
                if 6 <= nx < VW - 6 and 5 <= ny < VH - 5:
                    hx, hy = nx, ny                     # the hero walks: a glide
                    pg.glide(0, move[0] * 2, move[1] * 2, 4)
                else:
                    cx = min(max(cx + move[0], 0), W - VW)  # the map scrolls under the hero
                    cy = min(max(cy + move[1], 0), H - VH)
                    draw(cx, cy, "at %d,%d" % (cx + hx, cy + hy))
    finally:
        pg.sid_reset()
        pg.hide(0)
        pg.hide(1)
        termios.tcsetattr(fd, termios.TCSADRAIN, old)
        sys.stdout.write("\x1b[?25h\x1b[0m\x1b[2J")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
