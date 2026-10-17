"""
Generates the extension icons (16/48/128) without any third-party library.

Design: teal gradient rounded square, white speech bubble with three dots.
Rendered at 8x and box-filtered down, which gives clean anti-aliasing.
"""

import struct
import zlib
from pathlib import Path

SS = 8  # supersampling factor

BG_TOP = (20, 184, 146)
BG_BOTTOM = (10, 122, 94)
BUBBLE = (255, 255, 255)
DOT = (13, 138, 106)


def in_rounded_rect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def in_circle(x, y, cx, cy, r):
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def in_triangle(x, y, p1, p2, p3):
    def sign(a, b, c):
        return (a[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (a[1] - c[1])

    d1 = sign((x, y), p1, p2)
    d2 = sign((x, y), p2, p3)
    d3 = sign((x, y), p3, p1)
    has_neg = d1 < 0 or d2 < 0 or d3 < 0
    has_pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (has_neg and has_pos)


def sample(x, y):
    """Returns RGBA for a point in the 0..1 unit square."""
    # Background
    if not in_rounded_rect(x, y, 0.0, 0.0, 1.0, 1.0, 0.235):
        return (0, 0, 0, 0)

    t = y
    r = round(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t)
    g = round(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t)
    b = round(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t)
    color = (r, g, b, 255)

    # Speech bubble body
    if in_rounded_rect(x, y, 0.175, 0.215, 0.825, 0.655, 0.135):
        color = (*BUBBLE, 255)
    # Bubble tail
    elif in_triangle(x, y, (0.265, 0.60), (0.265, 0.815), (0.455, 0.645)):
        color = (*BUBBLE, 255)

    # Dots
    for cx in (0.335, 0.5, 0.665):
        if in_circle(x, y, cx, 0.435, 0.052):
            color = (*DOT, 255)

    return color


def render(size):
    hi = size * SS
    # Accumulate in float for the box filter
    out = bytearray()
    rows = []
    for py in range(hi):
        row = []
        y = (py + 0.5) / hi
        for px in range(hi):
            x = (px + 0.5) / hi
            row.append(sample(x, y))
        rows.append(row)

    for oy in range(size):
        line = bytearray()
        for ox in range(size):
            acc_r = acc_g = acc_b = acc_a = 0
            for sy in range(SS):
                row = rows[oy * SS + sy]
                for sx in range(SS):
                    r, g, b, a = row[ox * SS + sx]
                    acc_r += r * a
                    acc_g += g * a
                    acc_b += b * a
                    acc_a += a
            n = SS * SS
            if acc_a:
                line += bytes((acc_r // acc_a, acc_g // acc_a, acc_b // acc_a, acc_a // n))
            else:
                line += b'\x00\x00\x00\x00'
        out += b'\x00' + line
    return bytes(out)


def write_png(path, size):
    raw = render(size)

    def chunk(tag, data):
        payload = tag + data
        return struct.pack('>I', len(data)) + payload + struct.pack('>I', zlib.crc32(payload) & 0xFFFFFFFF)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    Path(path).write_bytes(png)
    print(f'{path}  {size}x{size}  {len(png)} bytes')


if __name__ == '__main__':
    out_dir = Path(__file__).resolve().parent.parent / 'icons'
    out_dir.mkdir(exist_ok=True)
    for s in (16, 48, 128):
        write_png(out_dir / f'icon{s}.png', s)
