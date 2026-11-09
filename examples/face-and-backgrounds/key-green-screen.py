#!/usr/bin/env python3
"""Turn a portrait on a flat green background into a transparent PNG cutout.

    pip install pillow numpy
    python3 key-green-screen.py face-green.jpg face.png [--low 25] [--high 170]

Upload the PNG with catalog.createFace. See docs/api/design.md.
"""
import argparse

import numpy as np
from PIL import Image, ImageFilter

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument('src', help='portrait on a flat green background')
ap.add_argument('out', help='transparent PNG to write')
ap.add_argument('--low', type=float, default=25, help='greenness at or below this stays opaque (default 25)')
ap.add_argument('--high', type=float, default=170, help='greenness at or above this becomes transparent (default 170)')
args = ap.parse_args()

im = np.asarray(Image.open(args.src).convert('RGB')).astype(np.float32)
r, g, b = im[..., 0], im[..., 1], im[..., 2]

# 1. Difference key: how much greener the pixel is than its red and blue.
greenness = g - np.maximum(r, b)
alpha = 1.0 - np.clip((greenness - args.low) / (args.high - args.low), 0, 1)

# 2. Despill: cap green at the average of red and blue, so edge pixels lose the green tint.
g = np.minimum(g, (r + b) / 2.0)
rgb = np.clip(np.stack([r, g, b], -1), 0, 255).astype(np.uint8)

# 3. Shave 1 to 2 px off the matte to drop the halo, then soften the edge.
matte = Image.fromarray((alpha * 255).astype(np.uint8))
matte = matte.filter(ImageFilter.MinFilter(5)).filter(ImageFilter.GaussianBlur(0.8))

out = Image.fromarray(rgb).convert('RGBA')
out.putalpha(matte)
out.save(args.out, optimize=True)
print(f'wrote {args.out}: {np.asarray(matte).mean() / 2.55:.0f}% opaque')
