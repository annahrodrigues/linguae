"""
Record the course audio with Kokoro-82M, locally.

    python tools/kokoro.py --voices          what it can and cannot speak
    python tools/kokoro.py fr                record the whole French course
    python tools/kokoro.py fr --limit 6      just the first few, to audition
    python tools/kokoro.py fr --words        the single words on the tiles
    python tools/kokoro.py --all --audit  read every clip back against the model
    python tools/kokoro.py --all             every course Kokoro has a voice for
    node tools/audio.js manifest             then index what was written

A "build the sentence" exercise cuts a phrase into tiles, and a tile is
almost never an item of its own, so tapping one plays nothing unless the
machine happens to have a voice for that language. --words records the
pieces as well, into assets/audio/<lang>/w/.

Kokoro-82M is an 82-million-parameter model under Apache-2.0, so the clips are
made on this machine with no API key and no per-character cost. This script
drives the ONNX build, which runs on CPU and installs on current Pythons:

    pip install kokoro-onnx soundfile misaki espeakng-loader

and the weights, which are too big to commit and land in tools/models/:

    https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.1
      kokoro-v1.0.onnx   voices-v1.0.bin

The phrases are read out of the page by `node tools/audio.js list`, so the
courses stay the one source of truth.

A clip that is already on disk is left alone -- unless the course has been
rewritten under it. assets/audio/recorded.json holds the text each clip was
made from, so changing a word re-records it. Without that, adding the article
to the French nouns left ten clips saying "homme" where the page had come to
say "l\'homme", and nothing anywhere said so.

--audit is the slow way of asking the same question of a clip the ledger says
nothing about: every line is spoken again and kept only if it runs as long as
what is already on disk, to within a frame or two. It is how the ledger was
filled in the first place, and what to reach for when it is in doubt.
"""

import argparse
import io
import json
import os
import subprocess
import sys

# Windows consoles default to cp1252, which cannot print a Latin macron or a
# French circumflex; the progress line should never be what stops a recording.
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MODELS = os.path.join(HERE, "models")
AUDIO = os.path.join(ROOT, "assets", "audio")
FORMAT = "mp3"

# Kokoro v1.0 speaks eight languages, and German is not among them, so the
# German course stays on whatever voice the visitor's system provides.
# Latin has no voice anywhere; it is read with the Italian one, which is the
# ecclesiastical convention and matches what the app already asks of
# speechSynthesis (it-IT).
VOICES = {
    "en": {"voice": "af_heart", "lang": "en-us", "note": "American English, the model's best-graded voice"},
    "fr": {"voice": "ff_siwis", "lang": "fr-fr", "note": ""},
    "es": {"voice": "ef_dora", "lang": "es", "note": ""},
    "it": {"voice": "if_sara", "lang": "it", "note": ""},
    "la": {"voice": "if_sara", "lang": "it", "note": "Italian voice, ecclesiastical reading"},
}
UNVOICED = {
    "de": "Kokoro v1.0 has no German voice; that course keeps the system voice",
    "ru": "Kokoro v1.0 has no Russian voice either; same fallback",
}


def phrases(lang, which="list"):
    """id, BCP-47 tag and text, straight from the page."""
    out = subprocess.run(
        ["node", os.path.join(HERE, "audio.js"), which, lang],
        capture_output=True, text=True, encoding="utf-8", cwd=ROOT,
    )
    if out.returncode:
        sys.exit("could not read the course: " + out.stderr.strip())
    rows = []
    for line in out.stdout.splitlines()[1:]:
        parts = line.split("\t")
        if len(parts) == 3:
            rows.append({"id": parts[0], "tag": parts[1], "text": parts[2]})
    return rows


def engine():
    try:
        from kokoro_onnx import Kokoro
    except ImportError:
        sys.exit("kokoro-onnx is missing: pip install kokoro-onnx soundfile misaki espeakng-loader")
    model = os.path.join(MODELS, "kokoro-v1.0.onnx")
    voices = os.path.join(MODELS, "voices-v1.0.bin")
    for f in (model, voices):
        if not os.path.exists(f):
            sys.exit("missing " + os.path.relpath(f, ROOT) + "\n"
                     "get it from the model-files-v1.1 release linked at the top of this file")
    return Kokoro(model, voices)


def record(lang, limit=0, force=False, speed=1.0, which="list", audit=False):
    if lang in UNVOICED:
        print(lang + ": " + UNVOICED[lang])
        return 0
    if lang not in VOICES:
        sys.exit("no voice mapped for " + lang)

    import numpy as np
    import soundfile as sf

    spec = VOICES[lang]
    rows = phrases(lang, which)
    if limit:
        rows = rows[:limit]
    folder = os.path.join(AUDIO, lang)
    os.makedirs(folder, exist_ok=True)
    k = engine()

    book = read_ledger()
    said = book.setdefault(lang, {})

    written = skipped = redone = 0
    for i, row in enumerate(rows, 1):
        path = os.path.join(folder, *(row["id"].split("/"))) + "." + FORMAT
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fresh = os.path.exists(path) and said.get(row["id"]) == row["text"]
        if fresh and not force and not audit:
            skipped += 1
            continue
        audio, rate = k.create(row["text"], voice=spec["voice"], speed=speed, lang=spec["lang"])
        if not len(audio) or float(np.abs(audio).max()) < 0.01:
            print("  silent, skipped: " + row["id"] + "  " + row["text"])
            continue
        if audit and not force and os.path.exists(path):
            was = seconds(path)
            if was is not None and abs(was - len(audio) / float(rate)) < SAME:
                said[row["id"]] = row["text"]
                skipped += 1
                continue
            print("  %3d/%d  %-10s was %s, the line says %r"
                  % (i, len(rows), row["id"],
                     "unreadable" if was is None else "%.2fs" % was, row["text"]))
        if os.path.exists(path):
            redone += 1
        sf.write(path, audio, rate, format="MP3")
        said[row["id"]] = row["text"]
        written += 1
        print("  %3d/%d  %-10s %5.2fs  %s" % (i, len(rows), row["id"], len(audio) / rate, row["text"]))
    write_ledger(book)
    print("%s: %d written%s, %d already there%s"
          % (lang, written, ", %d of them rewritten under a changed word" % redone if redone else "",
             skipped, "  (" + spec["note"] + ")" if spec["note"] else ""))
    return written


def seconds(path):
    """How long a clip on disk runs, or None if it cannot be read."""
    try:
        import soundfile as sf
        a, rate = sf.read(path, always_2d=True)
        return len(a) / float(rate)
    except Exception:
        return None


# Two clips of the same line never come out byte for byte the same -- the
# encoder sees to that -- but they run to the same length every time, so the
# length is what a clip can be checked against.
SAME = 0.03


def ledger_path():
    return os.path.join(AUDIO, "recorded.json")


def read_ledger():
    """What each clip on disk was made from, by language and id."""
    try:
        with io.open(ledger_path(), encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def write_ledger(book):
    os.makedirs(AUDIO, exist_ok=True)
    with io.open(ledger_path(), "w", encoding="utf-8", newline="\n") as f:
        json.dump(book, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")


def show():
    print("Kokoro v1.0, 54 voices across eight languages.\n")
    for lang, spec in VOICES.items():
        line = "  %-3s %-9s lang=%-6s" % (lang, spec["voice"], spec["lang"])
        print(line + ("  " + spec["note"] if spec["note"] else ""))
    for lang, why in UNVOICED.items():
        print("  %-3s %s" % (lang, why))


def main():
    ap = argparse.ArgumentParser(description="Record the course audio with Kokoro-82M.")
    ap.add_argument("lang", nargs="?", help="course to record: " + ", ".join(VOICES))
    ap.add_argument("--all", action="store_true", help="every course Kokoro has a voice for")
    ap.add_argument("--voices", action="store_true", help="show the voice for each course")
    ap.add_argument("--limit", type=int, default=0, help="only the first N phrases")
    ap.add_argument("--words", action="store_true",
                    help="the single words the sentence tiles show, into <lang>/w/")
    ap.add_argument("--force", action="store_true", help="redo clips that already exist")
    ap.add_argument("--audit", action="store_true",
                    help="speak every line again and keep the clip only if it still matches")
    ap.add_argument("--speed", type=float, default=1.0, help="1.0 is the natural rate")
    a = ap.parse_args()

    if a.voices or (not a.lang and not a.all):
        show()
        return
    total = 0
    which = "words" if a.words else "list"
    for lang in (list(VOICES) if a.all else [a.lang]):
        total += record(lang, a.limit, a.force, a.speed, which, a.audit)
    if total:
        print("\nnow run:  node tools/audio.js manifest")


if __name__ == "__main__":
    main()
