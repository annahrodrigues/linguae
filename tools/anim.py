"""
Turn a hand-made GIF of Leon into something a page should carry.

    python tools/anim.py mascot/achievements.gif assets/leon-trophy.webp
    python tools/anim.py mascot/studyLeon.gif assets/leon-study.webp --width 208
    python tools/anim.py --check assets/leon-trophy.webp

A GIF has one bit of transparency: a pixel is either fully there or fully
gone. Leon is drawn in curves, so that edge arrives as a staircase over the
page, and it shows most where the background is not white. Animated WebP
carries a real alpha channel, so the edge can be soft -- and the file lands
at a fraction of the size, which for a picture that loops forever matters.

The softness is made here rather than found: the frames come in larger than
they are shown and are shrunk with the colour premultiplied by the alpha, so
a pixel on the border mixes with its neighbours instead of with transparent
black. That is the same trick tools/mascot.py uses on the still drawings.

Needs Pillow and NumPy:  pip install pillow numpy
"""

import argparse
import os
import sys

import numpy as np
from PIL import Image, ImageSequence

import mascot          # same folder: the background cut lives there


def frames_of(path):
    im = Image.open(path)
    out, delays = [], []
    for f in ImageSequence.Iterator(im):
        out.append(f.convert("RGBA"))
        delays.append(f.info.get("duration") or im.info.get("duration") or 100)
    return out, delays


def cut_all(frames):
    """A GIF that arrives flattened onto the export checkerboard has no
    transparency at all to keep, so it is reconstructed frame by frame the way
    tools/mascot.py does the stills. Every frame is then cropped to the same
    box -- one box for all of them, or the drawing would jump about as the
    bounding box followed the tail from frame to frame."""
    done = [mascot.cut_image(f)[0] for f in frames]
    box = None
    for f in done:
        b = f.getbbox()
        if not b:
            continue
        box = b if box is None else (min(box[0], b[0]), min(box[1], b[1]),
                                     max(box[2], b[2]), max(box[3], b[3]))
    if not box:
        sys.exit("nothing survived the cut; the drawing may be too pale for those thresholds")
    return [f.crop(box) for f in done]


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


def soft(im):
    a = np.asarray(im)[..., 3]
    return int(((a > 0) & (a < 255)).sum())


def build(src, dst, width, quality):
    frames, delays = frames_of(src)
    if not frames:
        sys.exit("no frames in " + src)
    before = soft(frames[0])
    was = frames[0].size
    if not any(np.asarray(f)[..., 3].min() < 255 for f in frames):
        print("  no transparency anywhere: cutting the background out first")
        frames = cut_all(frames)
    frames = [shrink(f, width) for f in frames]
    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    frames[0].save(dst, format="WEBP", save_all=True, append_images=frames[1:],
                   duration=delays, loop=0, lossless=False, quality=quality,
                   method=6, exact=False)
    print("%s -> %s" % (src, dst))
    print("  %d frames, %dms each, %dx%d (was %dx%d)"
          % (len(frames), delays[0], frames[0].size[0], frames[0].size[1], was[0], was[1]))
    print("  soft edge pixels per frame: %d -> %d" % (before, soft(frames[0])))
    print("  %d bytes (was %d)" % (os.path.getsize(dst), os.path.getsize(src)))


def check(path):
    frames, delays = frames_of(path)
    im = Image.open(path)
    print("%s  %s  %d bytes" % (path, im.size, os.path.getsize(path)))
    print("  %d frames, %s" % (len(frames), "%dms each" % delays[0]
                               if len(set(delays)) == 1 else "mixed delays"))
    print("  loops: %s" % ("forever" if im.info.get("loop", 0) == 0 else im.info.get("loop")))
    print("  soft edge pixels in frame 1: %d" % soft(frames[0]))
    print("  runs for %.2fs" % (sum(delays) / 1000.0))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src", help="the GIF, or the file to inspect with --check")
    ap.add_argument("dst", nargs="?", help="where to write it")
    ap.add_argument("--width", type=int, default=300,
                    help="width in pixels (default 300, about twice the size it is shown)")
    ap.add_argument("--quality", type=int, default=84, help="WebP quality (default 84)")
    ap.add_argument("--check", action="store_true", help="inspect a finished file instead")
    a = ap.parse_args()

    if a.check:
        check(a.src)
        return
    if not a.dst:
        ap.error("a destination is required unless you pass --check")
    build(a.src, a.dst, a.width, a.quality)


if __name__ == "__main__":
    main()
