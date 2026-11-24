"""
Propose the next lesson from a corpus, so the writing starts from candidates.

    python tools/harvest.py --fetch ~/tatoeba          download the dumps
    python tools/harvest.py de --unit u4 --corpus ~/tatoeba
    python tools/harvest.py de --unit u4 --corpus ~/tatoeba --words 30

The hard part of a lesson was never the translation. It is deciding which ten
words belong together, and then finding six sentences that use them and use
nothing the learner has not already met. This does the second half: it reads
the course as it stands, works out what has been taught, and offers the
sentences from Tatoeba that are built only out of that.

What comes out is a shortlist, not a lesson. Every line still has to be read,
chosen, cut and corrected by someone who knows the language: the corpus has
plenty of sentences that are correct and useless, and a few that are neither.

WHERE THE WORDS COME FROM. The order to teach words in is taken from how often
they appear in Tatoeba itself, rather than from a frequency list of its own.
That is partly a licence question -- the obvious lists are ShareAlike, and this
is not -- but mostly it is the better measure: a word is worth teaching here if
the corpus can also show it in a sentence, and a word with no sentences behind
it cannot be taught no matter how common it is in the world.

LICENCE. Tatoeba's sentences are CC BY 2.0 FR: they may be reused, changed and
redistributed, with credit. Keeping a sentence from the shortlist is reuse, so
the page footer and the README credit Tatoeba with a link and the licence name.
The dumps themselves are not committed; --fetch gets them again in a minute.

Needs nothing but the standard library.
"""

import argparse
import bz2
import io
import json
import os
import re
import subprocess
import sys
import urllib.request

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# Which language each course teaches, and which one the learner arrives with.
# They are the same pair everywhere but the English course, which teaches
# English to someone who has Portuguese.
TAUGHT = {"es": "spa", "fr": "fra", "de": "deu", "it": "ita",
          "la": "lat", "ru": "rus", "en": "eng"}
FROM = {"es": "eng", "fr": "eng", "de": "eng", "it": "eng",
        "la": "eng", "ru": "eng", "en": "por"}
EXPORTS = "https://downloads.tatoeba.org/exports/per_language/"


def fetch(into):
    """The weekly exports, for every language this app teaches."""
    os.makedirs(into, exist_ok=True)
    want = set(TAUGHT.values()) | set(FROM.values())
    files = ["%s/%s_sentences.tsv.bz2" % (c, c) for c in sorted(want)]
    for lg in sorted(TAUGHT):
        a, b = TAUGHT[lg], FROM[lg]
        files.append("%s/%s-%s_links.tsv.bz2" % (a, a, b))
    for path in files:
        name = path.split("/")[-1]
        dst = os.path.join(into, name)
        if os.path.exists(dst):
            print("  have   " + name)
            continue
        print("  get    " + name)
        try:
            urllib.request.urlretrieve(EXPORTS + path, dst)
        except Exception as e:
            print("    could not: %s" % e)
    print("\nthe dumps are not committed; they are CC BY 2.0 FR and a minute away")


def sentences(corpus, code):
    """id -> text, out of one language's export."""
    path = os.path.join(corpus, "%s_sentences.tsv.bz2" % code)
    if not os.path.exists(path):
        sys.exit("missing " + path + "\n  run with --fetch first")
    out = {}
    with bz2.open(path, "rt", encoding="utf-8", errors="replace") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 3:
                out[parts[0]] = parts[2]
    return out


def pairs(corpus, taught, comes_from):
    """Every (taught, already known) pair the corpus holds for this course.

    Tatoeba files an export under the folder of the language it is named for,
    so both directions exist and the one named for the language being taught
    has that language on the left. Reading the other would be quiet rather
    than loud: the sieve would find nothing, because it would be asking
    whether Portuguese sentences are built out of English words."""
    path = os.path.join(corpus, "%s-%s_links.tsv.bz2" % (taught, comes_from))
    if not os.path.exists(path):
        sys.exit("missing " + path + "\n  run with --fetch first")
    left, right = sentences(corpus, taught), sentences(corpus, comes_from)
    out = []
    with bz2.open(path, "rt", encoding="utf-8", errors="replace") as f:
        for line in f:
            a, _, b = line.rstrip("\n").partition("\t")
            b = b.strip()
            if a in left and b in right:
                out.append((left[a], right[b]))
    return out


WORD = re.compile(r"[^\W\d_]+(?:['’][^\W\d_]+)?", re.UNICODE)


def words_of(text):
    return [w.lower() for w in WORD.findall(text or "")]


def course(lang):
    """The course as the page has it: every lesson, in order, with its items."""
    out = subprocess.run(["node", os.path.join(HERE, "audio.js"), "course", lang],
                         capture_output=True, text=True, encoding="utf-8", cwd=ROOT)
    if out.returncode:
        sys.exit("could not read the course: " + (out.stderr or "").strip())
    return json.loads(out.stdout)


def taught_before(c, unit):
    """Every word the course has taught by the time this unit is reached.

    A sentence is only worth offering if the learner can read all of it, so
    this is the whole vocabulary up to and including the unit being written --
    the units before it, and the word lessons inside it."""
    known = set()
    for u in c["units"]:
        for l in u["lessons"]:
            if u["id"] == unit and l["kind"] != "w":
                continue
            for it in l["items"]:
                known.update(words_of(it["tgt"]))
        if u["id"] == unit:
            break
    return known


def already_said(c):
    """What the course already says, so nothing is offered twice."""
    return set(re.sub(r"\s+", " ", it["tgt"].strip().lower())
               for u in c["units"] for l in u["lessons"] for it in l["items"])


# Tatoeba writes its examples about the same handful of people, so their names
# come out near the top of any count and are worth nothing to a learner.
CAST = set("tom tomas thomas maria mary marie maria john johannes juan jean "
           "giovanni ivan ana anna anne betty alice bob ken mike jim bill "
           "boston australien australia frankreich".split())


def rank_words(rows, known, how_many):
    """The words the corpus leans on most that the course has not taught."""
    seen = {}
    for tgt, _ in rows:
        for w in set(words_of(tgt)):
            if w not in known and len(w) > 1 and w not in CAST:
                seen[w] = seen.get(w, 0) + 1
    return sorted(seen.items(), key=lambda kv: -kv[1])[:how_many]


def offer(rows, known, said, most, least, wanted=None):
    """Sentences built only out of what the learner can already read.

    Where a lesson's own ten words are named, the sentences that use them come
    first: a sieve that only answered "is this readable?" would bury them under
    a thousand short ones made of the oldest vocabulary in the course."""
    wanted = wanted or set()
    out = []
    for tgt, en in rows:
        flat = re.sub(r"\s+", " ", tgt.strip().lower())
        if flat in said:
            continue
        ws = words_of(tgt)
        if not (least <= len(ws) <= most):
            continue
        if any(w not in known for w in ws):
            continue
        if any(w in CAST for w in ws + words_of(en)):
            continue
        uses = len(wanted & set(ws))
        out.append((tgt.strip(), en.strip(), len(ws), uses))
    out.sort(key=lambda r: (-r[3], r[2], len(r[0])))
    seen, tidy = set(), []
    for tgt, en, n, _ in out:
        k = re.sub(r"\s+", " ", tgt.lower())
        if k in seen:
            continue
        seen.add(k)
        tidy.append((tgt, en, n))
    return tidy


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("lang", nargs="?", help="the course: es, fr, de, it, la, ru or en")
    ap.add_argument("--unit", help="the unit being written, e.g. u4")
    ap.add_argument("--corpus", help="where the dumps are")
    ap.add_argument("--fetch", metavar="DIR", help="download the dumps into DIR")
    ap.add_argument("--plus", default="",
                    help="words to pretend are taught too, comma separated: the ten a "
                         "new lesson is about, so the sieve can offer sentences for it")
    ap.add_argument("--words", type=int, default=24, help="how many words to suggest")
    ap.add_argument("--offers", type=int, default=40, help="how many sentences to offer")
    ap.add_argument("--most", type=int, default=6, help="longest sentence to offer, in words")
    ap.add_argument("--least", type=int, default=3, help="shortest")
    a = ap.parse_args()

    if a.fetch:
        fetch(a.fetch)
        return
    if not a.lang or not a.unit or not a.corpus:
        ap.error("a language, a --unit and a --corpus are needed")
    if a.lang not in TAUGHT:
        ap.error("no corpus mapped for " + a.lang)

    c = course(a.lang)
    known = taught_before(c, a.unit)
    said = already_said(c)
    # The ten words a new lesson is about are not in the course yet, so the
    # sieve cannot offer a single sentence for them. Naming them here is how
    # the question becomes "what could I say once these are taught?".
    plus = set(w.strip().lower() for w in a.plus.split(",") if w.strip())
    if plus:
        known |= plus
        print("with %d more words taken as taught: %s" % (len(plus), ", ".join(sorted(plus))))
    rows = pairs(a.corpus, TAUGHT[a.lang], FROM[a.lang])
    print("%s: %d sentence pairs in the corpus, %d words taught by the end of %s"
          % (a.lang, len(rows), len(known), a.unit))

    print("\n--- words the corpus leans on that %s has not taught ---" % a.lang)
    for w, n in rank_words(rows, known, a.words):
        print("   %-18s %d sentences" % (w, n))

    good = offer(rows, known, said, a.most, a.least, plus)
    print("\n--- %d sentences using only what is already taught ---" % len(good))
    for tgt, en, n in good[:a.offers]:
        print("   %-44s  %s" % (tgt, en))
    print("\nNone of this is a lesson yet. Read it, cut it, fix it.")


if __name__ == "__main__":
    main()
