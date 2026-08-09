# Shared data pipeline: parse ref-patterns.js, normalize coordinates, rasterize
# to grayscale images, and apply handwriting-style augmentation.
# IMPORTANT: the JS runtime (js/cnn.js) mirrors normalize_coords + rasterize EXACTLY.
import json
import math
import os
import re

import numpy as np

SIZE = 64          # model input size
PAD = 4            # blank border around the glyph
STEP = 0.5         # sampling step (px) when drawing segments

HERE = os.path.dirname(os.path.abspath(__file__))
REFPATH = os.environ.get(
    'REFPATH',
    os.path.join(os.path.dirname(HERE), 'vendor', 'ref-patterns.js'))


def load_refs(path=REFPATH):
    s = open(path, encoding='utf-8').read()
    start = s.index('refPatterns = [')
    arr = json.loads(s[s.index('['): s.rindex('];') + 1])
    # arr: [label, strokeCount, [[[x,y],...], ...]]
    labels = sorted({x[0] for x in arr})
    by_char = {}
    for x in arr:
        by_char.setdefault(x[0], []).append(x[2])
    return labels, by_char


def normalize_coords(strokes, size=SIZE, pad=PAD):
    """Map raw canvas strokes into a [pad, size-pad] box (aspect preserved, centered)."""
    pts = [p for st in strokes for p in st]
    if not pts:
        return []
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    bw = max(x1 - x0, 1e-6)
    bh = max(y1 - y0, 1e-6)
    s = (size - 2 * pad) / max(bw, bh)
    cx = (size - bw * s) / 2
    cy = (size - bh * s) / 2
    out = []
    for st in strokes:
        out.append([(p[0] * s - x0 * s + cx, p[1] * s - y0 * s + cy) for p in st])
    return out


def _sample_points(coords):
    """Flatten polylines into dense sample points (deterministic, STEP spacing)."""
    pts = []
    for st in coords:
        for i in range(len(st) - 1):
            x0, y0 = st[i]
            x1, y1 = st[i + 1]
            d = math.hypot(x1 - x0, y1 - y0)
            n = max(1, int(math.ceil(d / STEP)))
            for k in range(n):
                t = k / n
                pts.append((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))
        if st:
            pts.append(st[-1])
    return pts


def rasterize(coords, width=3, size=SIZE):
    """Draw stroke polylines as discs onto a white(0)/black-stroke(255) image."""
    img = np.zeros((size, size), np.float32)
    pts = _sample_points(coords)
    if not pts:
        return img.astype(np.uint8)
    r = width / 2.0
    R = int(math.ceil(r))
    yy, xx = np.ogrid[-R:R + 1, -R:R + 1]
    mask = (xx * xx + yy * yy) <= r * r
    for (x, y) in pts:
        xi = int(round(x))
        yi = int(round(y))
        x0, y0 = xi - R, yi - R
        x1, y1 = x0 + 2 * R, y0 + 2 * R
        if x1 < 0 or y1 < 0 or x0 >= size or y0 >= size:
            continue
        sx0 = max(x0, 0); sy0 = max(y0, 0)
        sx1 = min(x1, size - 1); sy1 = min(y1, size - 1)
        mx = mask[sy0 - y0:sy1 - y0 + 1, sx0 - x0:sx1 - x0 + 1]
        img[sy0:sy1 + 1, sx0:sx1 + 1][mx] = 255.0
    return img.astype(np.uint8)


def augment(coords, rng, stroke_widths=(1, 2, 3, 4, 5),
            rot=10.0, shear=0.15, jitter_sigma=0.9,
            merge_p=0.15, reorder_p=0.15):
    """Apply handwriting-style augmentation to normalized coords."""
    c = [list(map(list, st)) for st in coords]

    # affine: rotate + shear around center of the drawing box
    if len(c):
        flat = [p for st in c for p in st]
        cx = sum(p[0] for p in flat) / len(flat)
        cy = sum(p[1] for p in flat) / len(flat)
        th = math.radians(rng.uniform(-rot, rot))
        sh = rng.uniform(-shear, shear)
        cth, sth = math.cos(th), math.sin(th)
        def apply(p):
            dx, dy = p[0] - cx, p[1] - cy
            # shear then rotate
            dx2 = dx + sh * dy
            x = cx + cth * dx2 - sth * dy
            y = cy + sth * dx2 + cth * dy
            return (x, y)
        c = [[apply(p) for p in st] for st in c]

    # point jitter
    for st in c:
        for i in range(len(st)):
            st[i] = (st[i][0] + rng.normal(0, jitter_sigma),
                     st[i][1] + rng.normal(0, jitter_sigma))

    # occasional stroke merge (handwriting sloppiness)
    if merge_p and len(c) >= 2 and rng.random() < merge_p:
        a = rng.integers(0, len(c))
        b = rng.integers(0, len(c) - 1)
        if b >= a:
            b += 1
        c[a] = c[a] + c[b]
        del c[b]

    # occasional stroke order flip
    if reorder_p and len(c) >= 2 and rng.random() < reorder_p:
        c.reverse()

    width = int(rng.choice(stroke_widths))
    return c, width


def make_sample(strokes, rng, augment_train=True):
    """Full pipeline: normalize -> (augment) -> rasterize -> tensor input [1,64,64]."""
    coords = normalize_coords(strokes)
    if augment_train:
        coords, width = augment(coords, rng)
    else:
        width = 3
    img = rasterize(coords, width)
    x = img.astype(np.float32) / 255.0
    return x[None, :, :]
