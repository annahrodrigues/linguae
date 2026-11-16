"""
Cut a mascot drawing out of its background and size it for the web.

    python tools/mascot.py mascot/directions.png assets/unit-u6.png
    python tools/mascot.py mascot/sad.png assets/mascot-sad.png --width 480
    python tools/mascot.py --check assets/unit-u1.png      inspect one that exists

The drawings arrive as RGB exports flattened onto a light checkerboard, so the
transparency has to be reconstructed rather than kept. Thresholding alone eats
the whites — the eyes, the brim of a sun hat — so the background is found by
flooding in from every border pixel instead: colour or darkness marks the
artwork, the flood marks the background, and whatever the flood cannot reach is
enclosed by the drawing and belongs to it.

A file that already has real transparency is used as it is.

Needs Pillow and NumPy:  pip install pillow numpy
"""

import argparse
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# A pixel is artwork if it is this far from grey, or this much darker than the
# lightest the flattened background ever gets.
SATURATION = 18
DARKNESS = 150
SPECK = 25          # checker squares only joined diagonally are not real holes


def cut(path):
    return cut_image(Image.open(path))


def cut_image(src):
    """The same cut, on an image already in hand: tools/anim.py reconstructs a
    GIF's frames with it, so there is one implementation of this and not two."""
    if src.mode in ("RGBA", "LA") or "transparency" in src.info:
        img = src.convert("RGBA")
        if np.asarray(img)[..., 3].min() < 255:
            return img, "kept the file's own transparency"

    rgb = np.asarray(src.convert("RGB")).astype(np.int16)
    mx = rgb.max(axis=2)
    art = ((mx - rgb.min(axis=2)) >= SATURATION) | (mx < DARKNESS)

    # .copy(): a fromarray image is read-only and floodfill silently does nothing.
    flag = Image.fromarray(np.where(art, 255, 0).astype(np.uint8), "L").copy()
    w, h = flag.size
    px = flag.load()
    border = ([(x, 0) for x in range(w)] + [(x, h - 1) for x in range(w)]
              + [(0, y) for y in range(h)] + [(w - 1, y) for y in range(h)])
    for xy in border:
        if px[xy] == 0:
            ImageDraw.floodfill(flag, xy, 128, thresh=0)
    bg = np.asarray(flag) == 128

    holes = Image.fromarray(np.where(~bg & ~art, 255, 0).astype(np.uint8), "L")
    holes = holes.filter(ImageFilter.MinFilter(SPECK)).filter(ImageFilter.MaxFilter(SPECK))
    bg = bg | (~art & (np.asarray(holes) == 0))

    alpha = np.where(bg, 0, 255).astype(np.uint8)
    return Image.fromarray(np.dstack([rgb.astype(np.uint8), alpha]), "RGBA"), \
        "cut from a flattened background (%.0f%% of the frame)" % (bg.mean() * 100)


def shrink(im, width):
    """Premultiplied downsample, so the transparent border never bleeds in."""
    if width >= im.size[0]:
        return im
    a = np.asarray(im).astype(np.float32) / 255.0
    pre = np.dstack([a[..., :3] * a[..., 3:4], a[..., 3:4]])
    h = max(1, round(width * im.size[1] / im.size[0]))
    small = np.asarray(Image.fromarray((pre * 255).astype(np.uint8), "RGBA")
                       .resize((width, h), Image.LANCZOS)).astype(np.float32) / 255.0
    al = np.clip(small[..., 3:4], 1e-4, 1.0)
    out = np.dstack([np.clip(small[..., :3] / al, 0, 1), small[..., 3:4]])
    return Image.fromarray((out * 255).round().astype(np.uint8), "RGBA")


def check(path):
    im = Image.open(path).convert("RGBA")
    a = np.asarray(im)
    alpha = a[..., 3]
    print("%s  %s  %d bytes" % (path, im.size, os.path.getsize(path)))
    print("  transparent: %.0f%% of the frame" % ((alpha == 0).mean() * 100))
    print("  soft edges:  %d pixels between 1 and 254" % ((alpha > 0) & (alpha < 255)).sum())
    if alpha.max() == 0:
        sys.exit("  the whole image is transparent")
    ys, xs = np.where(alpha > 0)
    print("  content box: %dx%d, touching the edge on %s"
          % (xs.max() - xs.min() + 1, ys.max() - ys.min() + 1,
             ", ".join(s for s, t in (("left", xs.min() == 0), ("top", ys.min() == 0),
                                      ("right", xs.max() == im.size[0] - 1),
                                      ("bottom", ys.max() == im.size[1] - 1)) if t) or "no side"))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src", help="the drawing, or the file to inspect with --check")
    ap.add_argument("dst", nargs="?", help="where to write it")
    ap.add_argument("--width", type=int, default=220,
                    help="widest side in pixels (default 220, enough for a unit bar)")
    ap.add_argument("--colors", type=int, default=200, help="palette size (default 200)")
    ap.add_argument("--check", action="store_true", help="inspect a finished file instead")
    a = ap.parse_args()

    if a.check:
        check(a.src)
        return
    if not a.dst:
        ap.error("a destination is required unless you pass --check")

    img, how = cut(a.src)
    box = img.getbbox()
    if not box:
        sys.exit("nothing survived the cut; the drawing may be too pale for these thresholds")
    img = img.crop(box)
    small = shrink(img, a.width).quantize(colors=a.colors, method=Image.FASTOCTREE)
    os.makedirs(os.path.dirname(os.path.abspath(a.dst)), exist_ok=True)
    small.save(a.dst, optimize=True)
    print("%s -> %s" % (a.src, a.dst))
    print("  %s" % how)
    print("  cropped to %dx%d, written at %dx%d, %d bytes (was %d)"
          % (img.size[0], img.size[1], small.size[0], small.size[1],
             os.path.getsize(a.dst), os.path.getsize(a.src)))
    name = os.path.splitext(os.path.basename(a.dst))[0]
    if name.startswith("unit-"):
        print('  add to UNIT_ART in index.html:  %s: "assets/%s.png"'
              % (name[5:], name))


if __name__ == "__main__":
    main()
