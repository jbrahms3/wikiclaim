import struct
import zlib
import math
import os

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "icons")
os.makedirs(OUT_DIR, exist_ok=True)

def write_png(path, size, pixels):
    def chunk(tag, data):
        c = tag + data
        return struct.pack("!I", len(data)) + c + struct.pack("!I", zlib.crc32(c) & 0xffffffff)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack("!IIBBBBB", size, size, 8, 6, 0, 0, 0)
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        for x in range(size):
            r, g, b, a = pixels[y * size + x]
            raw += bytes((r, g, b, a))
    idat = zlib.compress(bytes(raw), 9)
    with open(path, "wb") as f:
        f.write(sig)
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", idat))
        f.write(chunk(b"IEND", b""))

def lerp(a, b, t):
    return a + (b - a) * t

def make_icon(size):
    cx = cy = size / 2
    r_outer = size * 0.47
    pixels = [(0, 0, 0, 0)] * (size * size)

    gold_top = (255, 214, 92)
    gold_bot = (214, 158, 30)
    ring = (120, 82, 12)
    globe_line = (255, 255, 255)

    for y in range(size):
        for x in range(size):
            dx = x + 0.5 - cx
            dy = y + 0.5 - cy
            dist = math.sqrt(dx * dx + dy * dy)
            if dist > r_outer:
                continue
            t = (y / size)
            base = tuple(int(lerp(gold_top[i], gold_bot[i], t)) for i in range(3))
            edge = r_outer - dist
            alpha = 255
            if edge < 1.0:
                alpha = int(255 * max(0, edge))
            col = list(base)
            if edge < size * 0.045:
                blend = max(0, min(1, edge / (size * 0.045)))
                col = [int(lerp(ring[i], base[i], blend)) for i in range(3)]

            nx, ny = dx / r_outer, dy / r_outer
            lat_dist = abs(ny)
            on_meridian = abs(nx) < 0.06 and dist < r_outer * 0.98
            on_equator = abs(ny) < 0.055 and dist < r_outer * 0.98
            on_lat1 = abs(abs(ny) - 0.45) < 0.05 and (nx * nx + ny * ny) < 0.95
            if on_meridian or on_equator or on_lat1:
                col = [int(lerp(c, 255, 0.55)) for c in col]

            pixels[y * size + x] = (col[0], col[1], col[2], alpha)

    return pixels

for size in (16, 32, 48, 128):
    pixels = make_icon(size)
    write_png(os.path.join(OUT_DIR, f"icon{size}.png"), size, pixels)
    print("wrote", size)
