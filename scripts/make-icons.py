#!/usr/bin/env python3
"""Generate the Tabwing icon set (pure stdlib: zlib + struct).

The mark: three amber feathers sweeping up from the wings, on an ink tile.
"""

import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
EXT = os.path.join(ROOT, "extension", "icons")
DOCS = os.path.join(ROOT, "docs")

SS = 4  # supersampling factor
INK_TOP = (22, 29, 39)
INK_BOT = (11, 15, 21)
AMBER = (227, 168, 60)
AMBER_LIGHT = (242, 196, 120)

# Each feather: (start x, start y, end x, end y, half width, colour)
FEATHERS = (
    (0.20, 0.74, 0.80, 0.36, 0.105, AMBER),
    (0.23, 0.46, 0.64, 0.22, 0.085, AMBER_LIGHT),
)


def rounded_alpha(x, y, size, radius):
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    dx, dy = x - cx, y - cy
    return 1.0 if dx * dx + dy * dy <= radius * radius else 0.0


def seg_dist(x, y, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    denom = dx * dx + dy * dy
    t = 0.0 if denom == 0 else max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / denom))
    return ((x - (x1 + t * dx)) ** 2 + (y - (y1 + t * dy)) ** 2) ** 0.5


def render(size):
    n = size * SS
    radius = n * 0.22
    acc = [[[0.0, 0.0, 0.0, 0.0] for _ in range(n)] for _ in range(n)]

    for py in range(n):
        y = (py + 0.5) / n
        for px in range(n):
            x = (px + 0.5) / n
            if rounded_alpha(px + 0.5, py + 0.5, n, radius) == 0.0:
                continue
            t = (py + 0.5) / n
            r = INK_TOP[0] + (INK_BOT[0] - INK_TOP[0]) * t
            g = INK_TOP[1] + (INK_BOT[1] - INK_TOP[1]) * t
            b = INK_TOP[2] + (INK_BOT[2] - INK_TOP[2]) * t
            for x1, y1, x2, y2, half, colour in FEATHERS:
                if seg_dist(x, y, x1, y1, x2, y2) <= half:
                    r, g, b = colour
                    break
            acc[py][px] = [r, g, b, 255.0]

    rows = []
    for oy in range(size):
        row = bytearray()
        for ox in range(size):
            sr = sg = sb = sa = 0.0
            for dy in range(SS):
                for dx in range(SS):
                    p = acc[oy * SS + dy][ox * SS + dx]
                    sr += p[0] * p[3]
                    sg += p[1] * p[3]
                    sb += p[2] * p[3]
                    sa += p[3]
            if sa > 0:
                row += bytes((int(sr / sa), int(sg / sa), int(sb / sa), int(sa / (SS * SS))))
            else:
                row += bytes((0, 0, 0, 0))
        rows.append(bytes(row))
    return rows


def png(path, size, rows):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", zlib.compress(raw, 9)))
        f.write(chunk(b"IEND", b""))


def main():
    os.makedirs(EXT, exist_ok=True)
    targets = [(os.path.join(EXT, f"icon{s}.png"), s) for s in (16, 32, 48, 128)]
    targets += [
        (os.path.join(DOCS, "icon.png"), 512),
        (os.path.join(DOCS, "icon-192.png"), 192),
        (os.path.join(DOCS, "icon-32.png"), 32),
        (os.path.join(DOCS, "apple-touch-icon.png"), 180),
    ]
    for path, size in targets:
        png(path, size, render(size))
        print(f"wrote {os.path.relpath(path, ROOT)} ({size}px)")


if __name__ == "__main__":
    main()
