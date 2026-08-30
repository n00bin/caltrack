"""Generates the app icons. Run it if you ever change the mark:

    python tools/make-icons.py

Keeping the generator in the repo means the icons are reproducible rather
than a binary someone has to redraw by hand.

The mark is a barcode, drawn white on the app's green, full-bleed so it
works as an Android "maskable" icon: Android may crop the square to a
circle or a squircle, so nothing important goes near the corners. The bars
sit inside the middle 60%, which is well within the safe zone.
"""
from PIL import Image, ImageDraw
import os

GREEN = (47, 125, 79)        # --accent from style.css
WHITE = (255, 255, 255)

# Widths of the bars, as a barcode would have: thick and thin, uneven gaps.
PATTERN = [3, 1, 1, 2, 1, 4, 1, 1, 2, 3, 1, 2]

# At favicon size the thin bars smear into each other, so small icons get a
# coarser mark that still reads as a barcode.
PATTERN_SMALL = [3, 1, 2, 1, 3]

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(os.path.join(HERE, '..', 'icons'))


def draw_icon(size):
    # Supersample, then shrink: cheap anti-aliasing without a font or filter.
    scale = 4
    s = size * scale
    img = Image.new('RGB', (s, s), GREEN)
    d = ImageDraw.Draw(img)

    pattern = PATTERN if size >= 96 else PATTERN_SMALL
    span = s * 0.60           # the bars occupy the middle 60%
    left = (s - span) / 2
    top = (s - span) / 2
    height = span

    units = sum(pattern) + (len(pattern) - 1)   # bars plus one-unit gaps
    unit = span / units

    x = left
    for w in pattern:
        d.rectangle([x, top, x + w * unit, top + height], fill=WHITE)
        x += (w + 1) * unit

    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    for size in (32, 180, 192, 512):
        path = os.path.join(OUT, 'icon-%d.png' % size)
        draw_icon(size).save(path, 'PNG', optimize=True)
        print('wrote', path, os.path.getsize(path), 'bytes')


if __name__ == '__main__':
    main()
