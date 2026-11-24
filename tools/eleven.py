"""
Record the two courses Kokoro cannot speak, with ElevenLabs.

    python tools/eleven.py --voices          what the account can speak with
    python tools/eleven.py de                record the whole German course
    python tools/eleven.py de --limit 6      just the first few, to audition
    python tools/eleven.py de --words        the single words on the tiles
    python tools/eleven.py --all             German and Russian, both
    python tools/eleven.py --all --audit     read every clip back against the API
    node tools/audio.js manifest             then index what was written

Kokoro v1.0 speaks eight languages and neither German nor Russian is one of
them, so those two courses have had no recordings at all. ElevenLabs speaks
both. This is the same shape as tools/kokoro.py -- same rows out of the page,
same files, same ledger -- with the model on someone else's machine.

That difference is the whole reason to keep the two tools apart. Kokoro runs
here, under Apache-2.0, with no key, no quota and no terms that can change.
This one spends a monthly allowance against an account, so it is pointed at
the two courses that have nothing rather than at the five that are already
recorded and already free of all that.

WHAT IT COSTS. The free plan gives 10,000 credits a month and one character of
Multilingual v2 costs one credit. The German course is 3,439 characters and the
Russian 2,702, tiles and all, so both fit inside a single month with room over.
The allowance is checked before a run starts, because stopping half way through
a course leaves a lesson that speaks some of its words and not others.

THE KEY never reaches the page. These clips are recorded here and committed as
files, exactly like Kokoro's; the site serves .mp3 and has never held a key.
Put it in tools/.eleven-key, which .gitignore covers, or in ELEVENLABS_API_KEY.

THE LICENCE. ElevenLabs' terms, section 1(c): a user on the free plan "may only
use the Services for non-commercial purposes", and must hold the account under
a personal e-mail address. Linguae is free to use, carries no advertising, sells
nothing and asks for no account, which is the plain reading of that. The free
plan also asks that the work credit ElevenLabs; the README says so, and the
page footer has to carry the credit in the same commit that brings the clips,
not later. Nothing here is legal advice; if the app ever takes money, these
clips have to be made again under a paid plan or with Kokoro.

Needs nothing but the standard library. --audit also wants soundfile.
"""

import argparse
import io
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

# Windows consoles default to cp1252, which cannot print Cyrillic or an umlaut;
# the progress line should never be what stops a recording.
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
AUDIO = os.path.join(ROOT, "assets", "audio")
FORMAT = "mp3"
KEYFILE = os.path.join(HERE, ".eleven-key")

API = "https://api.elevenlabs.io/v1"
# Multilingual v2 covers both of these and costs one credit a character. Flash
# is half that, and the whole job fits in a month either way, so the better
# model wins.
MODEL = "eleven_multilingual_v2"
# 128 kbps at 44.1 kHz, which is what Kokoro's files already are.
AUDIO_FORMAT = "mp3_44100_128"

# Which of the account's own voices to read each course with, by name. Names
# rather than ids: the ids differ between accounts, and the free plan cannot
# reach the shared voice library through the API -- ElevenLabs' own quickstart
# says so -- so a run has to ask the account what it actually has.
#
# That restriction is worth knowing before a month of credits goes on it. The
# voices every account starts with are read by English speakers, and the
# multilingual model has them speak German and Russian rather than replacing
# them, so some of the English mouth survives the crossing. The native voices
# are in the shared library, which is the part the free plan cannot reach. So
# audition first -- `--limit 6` costs about fifty characters -- and listen
# before spending the rest. --voice picks another by name.
VOICES = {
    "de": {"voice": "Mary K.", "id": "iFSsEDGbm0FiEd2IVH4w",
           "note": "a native German reader, chosen by ear over three others"},
    "ru": {"voice": "Oleg", "id": "MWyJiWDobXN8FX3CJTdE",
           "note": "a native Russian reader, chosen the same way"},
}

# Two clips of one line are never identical byte for byte, but they run to the
# same length, so the length is what a clip can be checked against.
SAME = 0.05


def api_key():
    key = (os.environ.get("ELEVENLABS_API_KEY") or "").strip()
    if key:
        return key
    try:
        with io.open(KEYFILE, encoding="utf-8") as f:
            key = f.read().strip()
    except Exception:
        key = ""
    if not key:
        sys.exit(
            "no API key.\n"
            "  Put it in " + os.path.relpath(KEYFILE, ROOT) + " (which .gitignore covers),\n"
            "  or set ELEVENLABS_API_KEY.\n"
            "  ElevenCreative -> your account -> API Keys -> generate."
        )
    return key


class Refused(Exception):
    """The API would not do it. Carries enough to say why in one line."""

    def __init__(self, code, detail):
        self.code = code
        self.detail = detail or ""
        self.need = ""
        # A key can be scoped to some endpoints and not others, and the answer
        # names the permission it wanted: "missing the permission voices_read
        # to execute this operation". Worth lifting out -- it is the whole fix.
        try:
            says = json.loads(self.detail).get("detail") or {}
            message = says.get("message") or ""
            if "missing the permission" in message:
                self.need = message.split("missing the permission", 1)[1].split()[0]
        except Exception:
            pass
        Exception.__init__(self, "%d %s" % (code, self.detail[:300]))


def call(path, key, body=None, raw=False):
    """One request. Returns parsed JSON, or the bytes when raw."""
    req = urllib.request.Request(API + path, method="POST" if body is not None else "GET")
    req.add_header("xi-api-key", key)
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data, timeout=120) as r:
            payload = r.read()
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")[:400]
        except Exception:
            pass
        raise Refused(e.code, detail)
    except urllib.error.URLError as e:
        sys.exit("could not reach the API: %s" % e.reason)
    if raw:
        return payload
    return json.loads(payload.decode("utf-8"))


def blame(where, err):
    """What to tell someone whose key has just been turned away."""
    if err.need:
        return ("the key cannot %s: it is missing the %s permission.\n"
                "  Add it on the key at elevenlabs.io/app/api/api-keys, or see below."
                % (where, err.need))
    if err.code == 401:
        return "the API key was refused (401). Check it, or make a new one.\n  " + err.detail[:200]
    if err.code == 429:
        return "the account is out of credits or being rate limited (429).\n  " + err.detail[:200]
    return "the API said %d while trying to %s\n  %s" % (err.code, where, err.detail[:200])


def allowance(key):
    """How many credits are left this month, or None where the key may not look."""
    try:
        sub = call("/user/subscription", key)
    except Refused as e:
        if e.need:
            return None
        sys.exit(blame("read the allowance", e))
    used = int(sub.get("character_count") or 0)
    cap = int(sub.get("character_limit") or 0)
    return {"used": used, "cap": cap, "left": max(0, cap - used),
            "tier": sub.get("tier") or "unknown"}


def voices_of(key):
    """The voices this account can actually use, by name, or None where the
    key may not look."""
    try:
        found = call("/voices", key).get("voices") or []
    except Refused as e:
        if e.need:
            return None
        sys.exit(blame("list the voices", e))
    return [{"id": v.get("voice_id"), "name": v.get("name") or "",
             "kind": v.get("category") or ""} for v in found if v.get("voice_id")]


def pick_voice(key, want, voice_id=None):
    if voice_id:
        return {"id": voice_id, "name": want or voice_id, "kind": "named by id"}
    mine = voices_of(key)
    if mine is None:
        sys.exit("the key cannot list the voices: it is missing the voices_read permission.\n"
                 "  Add it on the key at elevenlabs.io/app/api/api-keys,\n"
                 "  or name the voice outright with --voice-id.")
    if not mine:
        sys.exit("the account has no voices to record with")
    for v in mine:
        if v["name"].lower() == want.lower():
            return v
    # The named voice is not on this account; say what is, rather than guess.
    sys.exit("no voice called %r on this account. It has: %s\n"
             "Pick one with --voice."
             % (want, ", ".join(sorted(v["name"] for v in mine))))


def phrases(lang, which="list"):
    """id, BCP-47 tag and text, straight from the page."""
    out = subprocess.run(
        ["node", os.path.join(HERE, "audio.js"), which, lang],
        capture_output=True, text=True, encoding="utf-8", cwd=ROOT,
    )
    if out.returncode:
        sys.exit("could not read the course: " + (out.stderr or "").strip())
    rows = []
    for line in out.stdout.splitlines()[1:]:
        parts = line.split("\t")
        if len(parts) == 3:
            rows.append({"id": parts[0], "tag": parts[1], "text": parts[2]})
    return rows


def seconds(path):
    """How long a clip on disk runs, or None if it cannot be read."""
    try:
        import soundfile as sf
        a, rate = sf.read(path, always_2d=True)
        return len(a) / float(rate)
    except Exception:
        return None


def ledger_path():
    return os.path.join(AUDIO, "recorded.json")


def read_ledger():
    try:
        with io.open(ledger_path(), encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def voice_of(book, lang):
    """Which voice last read this course, by id."""
    return (book.get("voices") or {}).get(lang) or ""


def set_voice(book, lang, voice_id):
    book.setdefault("voices", {})[lang] = voice_id


def write_ledger(book):
    os.makedirs(AUDIO, exist_ok=True)
    with io.open(ledger_path(), "w", encoding="utf-8", newline="\n") as f:
        json.dump(book, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")


def speak(key, voice_id, text):
    return call("/text-to-speech/" + voice_id + "?output_format=" + AUDIO_FORMAT,
                key, {"text": text, "model_id": MODEL}, raw=True)


def wanted(lang, which, limit, force, audit, said, same_voice=True):
    """The rows this run would actually spend credits on.

    A clip is left alone only when the file is there, the line is the one it
    was made from, and the voice has not changed under it. Changing the voice
    leaves every line as it was, so a ledger that knew only the words would
    skip the whole course and keep the old voice on disk."""
    rows = phrases(lang, which)
    if limit:
        rows = rows[:limit]
    todo = []
    for row in rows:
        path = os.path.join(AUDIO, lang, *(row["id"].split("/"))) + "." + FORMAT
        fresh = (os.path.exists(path) and said.get(row["id"]) == row["text"]
                 and same_voice)
        if fresh and not force and not audit:
            continue
        todo.append(row)
    return rows, todo


def record(lang, limit=0, force=False, which="list", audit=False, voice=None, yes=False,
           voice_id=None):
    if lang not in VOICES and not voice:
        sys.exit("no voice mapped for " + lang + "; name one with --voice")

    key = api_key()
    book = read_ledger()
    said = book.setdefault(lang, {})
    spec = VOICES.get(lang, {})
    # An id names one voice and nothing else, which is what a library voice
    # has to be reached by: a name would have to be looked up on the account,
    # and these two were never copied into it.
    if voice_id:
        chosen = pick_voice(key, voice, voice_id)
    elif voice:
        chosen = pick_voice(key, voice)
    else:
        chosen = pick_voice(key, spec.get("voice"), spec.get("id"))
    was = voice_of(book, lang)
    same_voice = not was or was == chosen["id"]
    if not same_voice:
        print("%s: the voice has changed since these were recorded; all of them again" % lang)
    rows, todo = wanted(lang, which, limit, force, audit, said, same_voice)
    if not rows:
        print(lang + ": nothing to record")
        return 0
    if not todo:
        print("%s: %d already there, none of them rewritten since" % (lang, len(rows)))
        return 0

    cost = sum(len(r["text"]) for r in todo)
    purse = allowance(key)
    if purse is None:
        print("%s: %d of %d lines to say, %d characters" % (lang, len(todo), len(rows), cost))
        if not yes:
            sys.exit("  the key cannot read the allowance: it is missing the user_read\n"
                     "  permission, so there is no telling whether the month covers this.\n"
                     "  Add it on the key at elevenlabs.io/app/api/api-keys, or pass --yes\n"
                     "  to go ahead without the check.")
        print("  going ahead without checking the allowance")
    else:
        print("%s: %d of %d lines to say, %d characters; %d credits left on %s"
              % (lang, len(todo), len(rows), cost, purse["left"], purse["tier"]))
        if cost > purse["left"] and not yes:
            sys.exit("  that is %d more than the account has. The allowance resets monthly;\n"
                     "  record one course now and the other after it does, or pass --yes to\n"
                     "  start anyway and stop when the credits run out."
                     % (cost - purse["left"]))

    print("  voice: %s (%s)" % (chosen["name"], chosen["kind"]))

    folder = os.path.join(AUDIO, lang)
    os.makedirs(folder, exist_ok=True)
    written = redone = kept = 0
    for i, row in enumerate(todo, 1):
        path = os.path.join(folder, *(row["id"].split("/"))) + "." + FORMAT
        os.makedirs(os.path.dirname(path), exist_ok=True)
        try:
            blob = speak(key, chosen["id"], row["text"])
        except Refused as e:
            write_ledger(book)
            sys.exit(blame("record " + row["id"], e))
        if not blob:
            print("  nothing came back for " + row["id"] + "  " + row["text"])
            continue
        if audit and not force and os.path.exists(path):
            was = seconds(path)
            tmp = path + ".new"
            with io.open(tmp, "wb") as f:
                f.write(blob)
            now = seconds(tmp)
            if was is not None and now is not None and abs(was - now) < SAME:
                os.remove(tmp)
                said[row["id"]] = row["text"]
                kept += 1
                continue
            os.remove(tmp)
            print("  %3d/%d  %-10s was %s, the line says %r"
                  % (i, len(todo), row["id"],
                     "unreadable" if was is None else "%.2fs" % was, row["text"]))
        if os.path.exists(path):
            redone += 1
        with io.open(path, "wb") as f:
            f.write(blob)
        said[row["id"]] = row["text"]
        set_voice(book, lang, chosen["id"])
        written += 1
        print("  %3d/%d  %-10s %6d bytes  %s" % (i, len(todo), row["id"], len(blob), row["text"]))
        write_ledger(book)        # after each one: a run that dies has still told the truth

    write_ledger(book)
    print("%s: %d written%s%s"
          % (lang, written,
             ", %d of them rewritten under a changed %s"
             % (redone, "voice" if not same_voice else "word") if redone else "",
             ", %d still good" % kept if kept else ""))
    return written


def show():
    print("ElevenLabs, for the two courses Kokoro has no voice for.\n")
    for lang, spec in VOICES.items():
        print("  %-3s %-12s %s" % (lang, spec["voice"], spec["note"]))
    print("\n  the other five are recorded by tools/kokoro.py, which runs on this machine")
    key = (os.environ.get("ELEVENLABS_API_KEY") or "").strip()
    if not key and os.path.exists(KEYFILE):
        key = "file"
    if not key:
        print("\n  no key yet: " + os.path.relpath(KEYFILE, ROOT) + " or ELEVENLABS_API_KEY")
        return
    key = api_key()
    purse = allowance(key)
    if purse is None:
        print("\n  the key cannot read the allowance (it wants the user_read permission)")
    else:
        print("\n  %s plan: %d of %d credits used, %d left"
              % (purse["tier"], purse["used"], purse["cap"], purse["left"]))
    mine = voices_of(key)
    if mine is None:
        print("  the key cannot list the voices either (voices_read)")
        print("\n  Both are read-only. Tick them on the key at elevenlabs.io/app/api/api-keys")
        print("  and this tool can check the month before it spends it.")
    else:
        print("  voices on this account: " + ", ".join(sorted(v["name"] for v in mine)))


def main():
    ap = argparse.ArgumentParser(description="Record German and Russian with ElevenLabs.")
    ap.add_argument("lang", nargs="?", help="de or ru")
    ap.add_argument("--all", action="store_true", help="both of them")
    ap.add_argument("--voices", action="store_true", help="what the account can speak with")
    ap.add_argument("--limit", type=int, default=0, help="only the first N lines")
    ap.add_argument("--words", action="store_true",
                    help="the single words the sentence tiles show, into <lang>/w/")
    ap.add_argument("--force", action="store_true", help="redo clips that already exist")
    ap.add_argument("--audit", action="store_true",
                    help="say every line again and keep the clip only if it still matches")
    ap.add_argument("--voice", help="a voice on the account, by name")
    ap.add_argument("--voice-id", dest="voice_id",
                    help="a voice by its id, for a key that may not list them")
    ap.add_argument("--yes", action="store_true",
                    help="start even when the allowance will not cover the whole run")
    a = ap.parse_args()

    if a.voices or (not a.lang and not a.all):
        show()
        return
    which = "words" if a.words else "list"
    total = 0
    for lang in (list(VOICES) if a.all else [a.lang]):
        total += record(lang, a.limit, a.force, which, a.audit, a.voice, a.yes, a.voice_id)
    if total:
        print("\nnow run:  node tools/audio.js manifest")


if __name__ == "__main__":
    main()
