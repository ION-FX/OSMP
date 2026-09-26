#!/usr/bin/env python3
"""Generate OSMP PNG icons (PWA/favicon) with PIL — no npm, no imagemagick.

Design: rounded-square with teal→violet aurora gradient + three equalizer bars.
"""
import math
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "webui" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

# gradient endpoints (hsl-ish picks matching --accent defaults: teal 178° → violet 265°)
C1 = (13, 190, 176)    # teal
C2 = (139, 92, 246)    # violet


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def gradient(size, angle_deg=115):
    """Diagonal linear gradient C1→C2."""
    img = Image.new("RGB", (size, size))
    px = img.load()
    a = math.radians(angle_deg)
    dx, dy = math.cos(a), math.sin(a)
    # project each pixel on the gradient axis, normalize
    corners = [(0, 0), (size, 0), (0, size), (size, size)]
    projs = [x * dx + y * dy for x, y in corners]
    lo, hi = min(projs), max(projs)
    for y in range(size):
        for x in range(size):
            t = ((x * dx + y * dy) - lo) / (hi - lo)
            px[x, y] = lerp(C1, C2, t)
    return img


def glow_overlay(size):
    """Soft radial light from top-left for depth."""
    ov = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(ov)
    cx, cy = size * 0.3, size * 0.25
    r = size * 0.85
    steps = 24
    for i in range(steps, 0, -1):
        rr = r * i / steps
        alpha = int(52 * (1 - i / steps) ** 1.6)
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=alpha)
    white = Image.new("RGB", (size, size), (255, 255, 255))
    return Image.composite(white, Image.new("RGB", (size, size), (0, 0, 0)), ov)


def eq_bars(size):
    """Three rounded equalizer bars, white, centered — like the SVG logo."""
    bars = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(bars)
    u = size / 48.0  # design on a 48 grid
    spec = [  # x, y_top, height
        (13, 22, 12),
        (22, 14, 20),
        (31, 19, 15),
    ]
    w = 4 * u
    for x, y, h in spec:
        d.rounded_rectangle(
            [x * u, y * u, x * u + w, y * u + h * u],
            radius=w / 2, fill=(255, 255, 255, 242))
    return bars


def ring(size, thickness_frac=0.075):
    """Rounded-square outline in white (logo frame)."""
    r = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(r)
    t = size * thickness_frac
    pad = size * 0.085
    rad = size * 0.26
    d.rounded_rectangle([pad, pad, size - pad, size - pad], radius=rad,
                        outline=(255, 255, 255, 235), width=int(t))
    return r


def compose(size, maskable=False):
    img = gradient(size)
    glow = glow_overlay(size)
    # screen-ish blend: soft top-left light
    img = Image.blend(img, glow, 0.14)
    img = img.convert("RGBA")

    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    if maskable:
        s2 = int(size * 0.74)
        off = (size - s2) // 2
        ring_layer = ring(s2)
        bars = eq_bars(s2)
        layer.paste(ring_layer, (off, off), ring_layer)
        layer.paste(bars, (off, off), bars)
    else:
        ring_layer = ring(size)
        bars = eq_bars(size)
        layer = Image.alpha_composite(ring_layer, bars)

    out = Image.alpha_composite(img, layer)

    if not maskable:
        out.putalpha(rounded_mask(size, int(size * 0.225)))
    return out


def main():
    sizes = {
        "icon-32.png": (32, False),
        "icon-192.png": (192, False),
        "icon-512.png": (512, False),
        "icon-maskable-512.png": (512, True),
    }
    for name, (size, maskable) in sizes.items():
        img = compose(size, maskable)
        img.save(OUT / name)
        print(f"wrote {OUT / name}")


if __name__ == "__main__":
    main()
