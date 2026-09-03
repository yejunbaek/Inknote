"""Generate build/icon.ico (and icon.png) for InkNote.

Regenerate with:  python build/make-icon.py
Requires Pillow:  pip install pillow
"""
import math
import os
from PIL import Image, ImageDraw

SIZE = 1024
OUT_DIR = os.path.dirname(os.path.abspath(__file__))

PURPLE = (122, 75, 212)
PINK = (200, 107, 216)
PAPER = (253, 252, 250)
INK = (35, 32, 28)


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius, fill=255)
    return m


def gradient(size, top, bottom):
    g = Image.new("RGB", (size, size))
    d = ImageDraw.Draw(g)
    for y in range(size):
        t = y / (size - 1)
        # Diagonal-ish blend, matching the app's brand mark.
        d.line([(0, y), (size, y)],
               fill=tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return g


def main():
    # Render at 3x and downsample — PIL has no antialiasing on shapes, so
    # supersampling is what keeps the ink stroke from looking faceted.
    s = SIZE * 3
    icon = Image.new("RGBA", (s, s), (0, 0, 0, 0))

    # Rounded gradient tile
    bg = gradient(s, PURPLE, PINK).convert("RGBA")
    icon.paste(bg, (0, 0), rounded_mask(s, int(s * 0.22)))

    d = ImageDraw.Draw(icon)

    # A page floating on the tile
    pad = int(s * 0.20)
    page = [pad, int(s * 0.16), s - pad, s - int(s * 0.14)]
    d.rounded_rectangle(page, int(s * 0.045), fill=PAPER)

    # Two ruled lines, as if typed
    lx0 = pad + int(s * 0.075)
    lx1 = s - pad - int(s * 0.075)
    lw = int(s * 0.022)
    for i, frac in enumerate((0.34, 0.44)):
        end = lx1 if i == 0 else lx0 + int((lx1 - lx0) * 0.62)
        d.rounded_rectangle([lx0, int(s * frac), end, int(s * frac) + lw],
                            lw // 2, fill=(206, 200, 191))

    # A handwritten stroke across the lower half — the "ink" half of the app
    pts = []
    for i in range(101):
        t = i / 100
        x = lx0 + (lx1 - lx0) * t
        y = s * 0.66 + math.sin(t * math.pi * 2.1) * s * 0.085
        pts.append((x, y))
    d.line(pts, fill=PURPLE, width=int(s * 0.055), joint="curve")

    # Pen nib at the end of the stroke
    tipx, tipy = pts[-1]
    d.ellipse([tipx - s * 0.035, tipy - s * 0.035, tipx + s * 0.035, tipy + s * 0.035],
              fill=INK)

    icon = icon.resize((SIZE, SIZE), Image.LANCZOS)
    icon.save(os.path.join(OUT_DIR, "icon.png"))
    icon.save(
        os.path.join(OUT_DIR, "icon.ico"),
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print("wrote icon.png and icon.ico")


if __name__ == "__main__":
    main()
