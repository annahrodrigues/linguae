# Linguae

A language-learning app in the spirit of Duolingo: a lesson trail, spaced
repetition, hearts, a streak and achievements. Five courses, every one of them
taught **from English** — Spanish, French, German, Italian and Latin.

The interface is in English. The mascot is **Leon**, a chameleon.

**Live:** https://annahrodrigues.github.io/linguae/ · **Artifact:** https://claude.ai/artifact/Fzbcf54MKVHHP2DgNhnv9K

## Running it

There is no build step, no dependency and no server to configure. The whole app
is one HTML file with the `assets/` folder beside it:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000/`.

Opening `index.html` straight from `file://` works too, but the browser blocks
some of the fonts and icons, so serving it over HTTP is better. The published
site is the same files, served by GitHub Pages from `main`; `.nojekyll` keeps
Pages from building anything and has it copy them across as they are.

## What is in it

| | |
|---|---|
| **Courses** | 7 courses, 7 units and 14 lessons each, 112 words and phrases per course. Spanish, French, German, Italian, Latin and Russian are taught from English; English is taught from Portuguese |
| **Exercises** | 7 kinds: match the pairs, pick the translation in either direction, listen and transcribe, build from a word bank, free typing, and say it out loud |
| **Marking** | accents and punctuation are normalised, and a one-letter typo counts as correct, with a note |
| **Spaced repetition** | Leitner boxes at 1, 3, 7, 16 and 35 days; get one wrong and the word drops to box 2 and comes back in the same session |
| **Practice** | a page of its own with four sets, none of them locked: today's review, a listening drill with nothing on screen but the sound, a pronunciation drill you answer by speaking, and the words you have answered wrong, the worst first. Up to 10 words a session, no hearts at stake, 8 XP |
| **Progress** | 5 crowns per lesson, XP, a daily goal of 30 XP, a day streak and 9 achievements |
| **Hearts** | 5 per lesson; run out and the lesson restarts |
| **Sounds** | a recording on each answer, and three for the end of a lesson: a clean run, a run with up to three misses, and one with more; where a browser will not play them, a pair of oscillators answers instead |
| **Audio** | a recorded clip when the repository has one, otherwise the browser's `speechSynthesis` at the natural rate, on the best voice the system offers — a neural or Google voice over a legacy one; with neither, that word goes quiet rather than be read in another language's accent |
| **Pronunciation** | the browser's own `SpeechRecognition` listens and the phrase is marked word by word; seven words in ten passes. See the note below on what this can and cannot tell you |
| **Accessibility** | every pair of text colours clears AA contrast (4.5:1) in both themes, checked by a test that reads the stylesheet |
| **More than one device** | a code made on one device and typed on the other, and the two histories are merged rather than one overwriting the other. `sync/` holds the small Cloudflare Worker behind it, already deployed |

Progress lives in `localStorage`, one record per course, under the key
`lingua-trail-v1`. There is no account and nothing is required of the network:
closing the tab loses nothing.

To carry it to a phone there is one optional piece, `sync/`: a Cloudflare Worker
holding one blob of JSON per code, free and not paused for sitting unused. It is
off until an address is saved in **Progress → Your devices**, and the app behaves
exactly as before while it is off — the browser is still where progress is read
from, and a device with no network loses nothing. When it is on, each device
**reads before it writes and merges the two**, so a phone that was offline all
week adds what it learnt instead of flattening the laptop:

- a word is taken from whichever device knows more about it — more answers is
  more history, and on a tie the one scheduled further out was answered later
- XP is the larger of the two, never the sum: both copies count the same past
- crowns take the best of each, and an achievement keeps the earlier stamp,
  which is when it was really earned
- which course is open belongs to the device in your hand

The server is deployed and the app already knows its address, so a device is
only ever asked for the code; `sync/README.md` has the five commands that put
another one up. There is no account and no password: the code is the key to the
stored copy, which the panel says plainly. The address is public because it is
in the page, so every request is counted against the address it came from.

## Tests

The engine runs under Node against small stand-ins for the browser, so there is
nothing to install and no build to run first:

```bash
node test.js
```

Thirty-odd cases, aimed at what fails quietly rather than at what is obvious on
screen: the review schedule and its intervals, how a typed answer is marked
(accents, punctuation, a one-letter slip), what a session does to crowns, XP,
hearts and the streak, and the shape of the course content. A broken schedule
still renders a perfectly good lesson, which is exactly why it needs a test.

Point `LINGUAE_PAGE` at another copy of the page to run the suite against it —
useful for checking that the tests still fail when you break something on
purpose.

## Recorded audio

Speech synthesis is the weak point of a language course: it depends on what
each visitor happens to have installed, and a machine with no French voice will
either say nothing or, worse, read French through whatever voice is default.

So a clip in the repository wins. Drop a file at
`assets/audio/<lang>/<item-id>.mp3` and the app plays it instead of the voice,
for everyone, the same way. Anything not recorded falls back to synthesis, so a
course can be filled in a few words at a time.

```bash
node tools/audio.js list fr > fr.tsv   # id, BCP-47 tag and text, one row each
node tools/audio.js manifest           # scan the folder, write assets/audio/index.json
node tools/audio.js status             # how much of each course is recorded
```

Send the TSV through whatever text-to-speech you prefer, save each row as
`<id>.<ext>` under `assets/audio/<lang>/`, and run `manifest`. Any one of mp3,
m4a, ogg, opus or wav works, as long as the whole set uses the same one — the
manifest carries the extension and the app builds the URL from it. Files whose
name matches no item are reported and left out.

### The clips in here were made with Kokoro-82M

[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) is an 82-million-parameter
text-to-speech model under Apache-2.0. It runs on the CPU of an ordinary laptop,
so the recordings cost nothing per character and need no API key.

```bash
pip install kokoro-onnx soundfile misaki espeakng-loader
# weights into tools/models/, from the model-files-v1.1 release of
# https://github.com/thewh1teagle/kokoro-onnx
python tools/kokoro.py --voices     # the voice used for each course
python tools/kokoro.py --all        # record everything it can speak
node tools/audio.js manifest
```

| | |
|---|---|
| French | `ff_siwis` |
| Spanish | `ef_dora` |
| Italian | `if_sara` |
| Latin | `if_sara`, the Italian voice — the ecclesiastical reading, and what the app already asked of `speechSynthesis` |
| German | **none.** Kokoro v1.0 speaks eight languages and German is not one of them, so that course stays on the visitor's own system voice |

The weights are around 350 MB and are not committed; `tools/models/` is ignored
and `tools/kokoro.py` says where to fetch them. The clips themselves are 448 clips, 4.3 MB in all.

`assets/audio/index.json` is the whole contract. Without it the app never asks
for a clip, so the feature costs nothing until the first file lands. Recording
a language also switches its listening exercises back on, item by item.

## What the pronunciation drill really measures

The drill uses `SpeechRecognition`, the listening half of the Web Speech API,
which is all a page with no server behind it can reach. Chrome and Edge send the
audio to Google's recogniser and Safari to Apple's; Firefox has none, and where
it is missing the set is shown greyed out rather than offered and then broken.
Chrome also wants the network for it.

What comes back is a transcript with up to five alternative readings, never a
score. So the question the drill asks is the one the transcript can answer
honestly — **did the phrase come through as French?** — and it is asked word by
word, so a phrase half said does not read the same as one missed outright. Every
alternative counts, because each is a hearing of the same breath and the
engine's second guess is often its better one; a word one letter out counts as
the transcript's spelling rather than your mouth, unless the word is too short
to spare a letter (*oui* and *lui* are not the same word).

Two things this cannot do, and does not claim to:

- **It does not grade a sound.** A recogniser has a language model behind it and
  snaps what it hears onto real words, so a passable accent passes and a careful
  one can still fail on a word the engine does not expect. It tells you that you
  were understood, which is a real thing to know, and not how close you were.
- **It says nothing about a single phoneme.** A mark per sound — the French `u`
  against `ou`, a nasal vowel, a dropped liaison — needs a model that scores the
  audio against the expected phonemes. That exists (Azure's Pronunciation
  Assessment, Speechace, ELSA) and it is a paid API with a key, which means a
  server to hold the key: the one thing this app does not have. A local model in
  WebAssembly would avoid the key and cost tens of megabytes on first load, and
  Whisper and Vosk transcribe too — they do not score either.

## Visual identity

The look follows the **Linguae Brand Book 1.0** and the **React UI Kit 2.2**,
both kept in this repository for reference:

- Colours, type (Outfit and DM Sans) and components come from the kit's `src/styles.css`
- The symbol is the vector *Hidden Chameleon L* monogram (`linguae-monogram.svg`)
- Leon's expressions come from the visual identity kit, shrunk down for the web
- Four animations: `assets/leon-study.webp` plays in the sidebar while a course
  is under way and gives way to a sleeping Leon in one that has not begun,
  `assets/leon-trophy.webp` lifts a trophy on the achievements page once there is
  one to lift, `assets/leon-practice.webp` reads at his desk above Practice, and
  `assets/leon-progress.webp` climbs towards a flag above Progress
- Each unit can carry its own illustration at `assets/unit-<unit id>.png`, listed
  in `UNIT_ART`; a unit without one just shows no picture
- `python tools/mascot.py <drawing> <destination>` cuts a drawing out of its
  background, crops and scales it; drawings that already have their own
  transparency are kept as they are
- `python tools/anim.py <gif> <destination>` turns a hand-made GIF into an
  animated WebP: a GIF's transparency is one bit, so its edges arrive as a
  staircase, and shrinking the frames with the colour premultiplied softens them.
  A GIF flattened onto the export checkerboard has its background cut out first,
  by the same code as the stills, with one crop box for every frame so the
  drawing does not jump
- Brand green `#248F70` is the reference; in the interface text uses `#1D7A5F`,
  the same green darkened just enough to clear AA
- The dark theme is warm rather than green: the brand's cream and golden yellow
  carry the surfaces, the text and the call to action, and green stays where it
  means something — the primary button, a right answer, progress

The five course tiles carry flags, drawn as inline SVG rather than emoji —
Windows has no glyphs for the regional-indicator pairs and falls back to the two
letters. Latin has no country, so it carries a Roman laurel on vermilion.

## Layout

```
index.html                      the whole app
test.js                         the engine's tests
tools/audio.js                  list what to record, index what is recorded
tools/kokoro.py                 record it with Kokoro-82M, on this machine
tools/mascot.py                 cut a drawing out of its background and size it
tools/anim.py                   turn a GIF into an animated WebP with soft edges
tools/sfx.py                    trim, mix and encode the interface sounds
sounds/                         the recordings tools/sfx.py builds from
assets/sfx/                     the built sounds the page plays
assets/                         what the page loads
assets/audio/                   recorded clips, if any, plus their index.json
Linguae_Brand_Kit_1.0.pdf       the brand manual
Linguae_Kit_Identidade_Visual/  mascot and logo at full size
Linguae_React_UI_Kit_2.2/       the React design system the tokens come from
Linguae_UI_Kit_1.0/             the original HTML/CSS/JS prototype
```

Inside `index.html` the order is: course content, index, state, helpers, brand
assets, achievements, speech, exercise builder, session, views and render.

## Licence

The Linguae brand, Leon and the material in the kits belong to the project's
author and are not covered by an open licence.
