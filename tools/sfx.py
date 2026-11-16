"""
Prepare the interface sounds for the web.

    python tools/sfx.py                      sounds/*.wav  ->  assets/sfx/*.opus
    python tools/sfx.py --check              report on what is already built

The recordings in sounds/ are long stereo WAVs. The app needs something that
starts the instant it is asked to: an MP3 cannot, because the encoder puts a
few dozen milliseconds of silence at the front of every file, which on a sound
that answers a click is a stutter. Ogg/Opus carries a pre-skip the decoder
honours exactly, so it starts clean, and it is a tenth of the size of WAV.

Two of the four are cut short on purpose: the recordings that answer a click
end in a long quiet wash, and the next question is already on screen while it
is still ringing. The table below says where each one is cut; the figures came
from reading the envelopes, not from taste.

Needs soundfile and NumPy:  pip install soundfile numpy
"""

import argparse
import os
import sys

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "sounds")
OUT = os.path.join(ROOT, "assets", "sfx")

# keep:   seconds of sound to keep, or None for all of it
# fade:   seconds of fade at the end, so a cut never clicks
# mono:   the two click sounds are all but mono already; the two endings carry
#         real stereo width and are left alone
# peak:   the two click sounds answer every single question, so they are mixed
#         below the two endings, which are heard once at the close of a lesson.
SOUNDS = {
    "correct_answer":    {"keep": 1.05, "fade": 0.16, "mono": True,  "peak": 0.58},
    "incorrect_answer":  {"keep": 0.95, "fade": 0.13, "mono": True,  "peak": 0.62},
    "finished_correct":  {"keep": None, "fade": 0.25, "mono": False, "peak": 0.92},
    "finished_mid":      {"keep": None, "fade": 0.25, "mono": False, "peak": 0.92},
    "finished_incorrect": {"keep": None, "fade": 0.25, "mono": False, "peak": 0.92},
}
QUIET = 0.004      # below this fraction of the peak counts as silence


def resample(a, sr_in, sr_out):
    """Opus only accepts 8, 12, 16, 24 or 48 kHz, and these came at 44.1.

    Resampling through the spectrum: take the transform, keep the bins that
    both rates share, and come back at the new length. It treats the signal as
    a loop, which would show at the joins — but the sound has already been
    trimmed to where it is silent at both ends, so there is nothing to join."""
    if sr_in == sr_out:
        return a
    n_in = len(a)
    n_out = int(round(n_in * sr_out / float(sr_in)))
    spec = np.fft.rfft(a, axis=0)
    keep = min(spec.shape[0], n_out // 2 + 1)
    moved = np.zeros((n_out // 2 + 1, a.shape[1]), dtype=complex)
    moved[:keep] = spec[:keep]
    return np.fft.irfft(moved, n=n_out, axis=0) * (n_out / float(n_in))


def trim(a):
    """Drop the silence at both ends."""
    env = np.abs(a).max(axis=1)
    loud = np.where(env > env.max() * QUIET)[0]
    if not len(loud):
        return a
    return a[loud[0]:loud[-1] + 1]


def build(name, spec, sr_out=48000):
    path = os.path.join(SRC, name + ".wav")
    if not os.path.exists(path):
        sys.exit("missing " + os.path.relpath(path, ROOT))
    a, sr = sf.read(path, always_2d=True)
    before = len(a) / sr

    a = trim(a)
    if spec["mono"]:
        a = a.mean(axis=1, keepdims=True)
    if spec["keep"]:
        a = a[:int(spec["keep"] * sr)]

    a = resample(a, sr, sr_out)
    sr = sr_out

    n = int(spec["fade"] * sr)
    if n and n < len(a):
        # cosine, so the fall is smooth where a straight line would edge.
        ramp = 0.5 * (1 + np.cos(np.linspace(0, np.pi, n)))
        a[-n:] = a[-n:] * ramp[:, None]
    # and a few milliseconds at the front, so the cut from silence cannot click
    lead = int(0.003 * sr)
    if lead and lead < len(a):
        a[:lead] = a[:lead] * np.linspace(0, 1, lead)[:, None]

    peak = float(np.abs(a).max())
    if peak:
        a = a * (spec["peak"] / peak)

    os.makedirs(OUT, exist_ok=True)
    dst = os.path.join(OUT, name + ".opus")
    sf.write(dst, a, sr, format="OGG", subtype="OPUS")
    print("  %-20s %.2fs -> %.2fs  %s  %d bytes (was %d)"
          % (name, before, len(a) / sr, "mono" if spec["mono"] else "stereo",
             os.path.getsize(dst), os.path.getsize(path)))
    return dst


def check():
    if not os.path.isdir(OUT):
        sys.exit("nothing built yet; run without --check")
    for name in SOUNDS:
        p = os.path.join(OUT, name + ".opus")
        if not os.path.exists(p):
            print("  %-20s missing" % name)
            continue
        a, sr = sf.read(p, always_2d=True)
        head = np.abs(a[:int(0.01 * sr)]).max()
        print("  %-20s %.2fs  %d Hz  %d ch  peak %.2f  first 10ms %.3f  %d bytes"
              % (name, len(a) / sr, sr, a.shape[1], float(np.abs(a).max()), float(head),
                 os.path.getsize(p)))


def main():
    ap = argparse.ArgumentParser(description="Prepare the interface sounds for the web.")
    ap.add_argument("--check", action="store_true", help="report on what is already built")
    a = ap.parse_args()
    if a.check:
        check()
        return
    print("sounds/ -> assets/sfx/")
    for name, spec in SOUNDS.items():
        build(name, spec)
    print("\nthe app looks them up by these names; nothing else to do")


if __name__ == "__main__":
    main()
