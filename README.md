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
| **Courses** | 5 languages, 7 units and 14 lessons each, 112 words and phrases per course |
| **Exercises** | 6 kinds: match the pairs, pick the translation in either direction, listen and transcribe, build from a word bank, and free typing |
| **Marking** | accents and punctuation are normalised, and a one-letter typo counts as correct, with a note |
| **Spaced repetition** | Leitner boxes at 1, 3, 7, 16 and 35 days; get one wrong and the word drops to box 2 and comes back in the same session |
| **Progress** | 5 crowns per lesson, XP, a daily goal of 30 XP, a day streak and 9 achievements |
| **Hearts** | 5 per lesson; run out and the lesson restarts |
| **Audio** | the browser's `speechSynthesis`; with no voice installed for a language, its listening exercises take themselves out |
| **Accessibility** | every pair of text colours clears AA contrast (4.5:1) in both themes |

Progress lives in `localStorage`, one record per course, under the key
`lingua-trail-v1`. There is no account, no backend and no network call — closing
the tab loses nothing, switching browsers loses everything.

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

## Visual identity

The look follows the **Linguae Brand Book 1.0** and the **React UI Kit 2.2**,
both kept in this repository for reference:

- Colours, type (Outfit and DM Sans) and components come from the kit's `src/styles.css`
- The symbol is the vector *Hidden Chameleon L* monogram (`linguae-monogram.svg`)
- Leon's expressions come from the visual identity kit, shrunk down for the web
- Brand green `#248F70` is the reference; in the interface text uses `#1D7A5F`,
  the same green darkened just enough to clear AA

The five course tiles carry flags, drawn as inline SVG rather than emoji —
Windows has no glyphs for the regional-indicator pairs and falls back to the two
letters. Latin has no country, so it carries a Roman laurel on vermilion.

## Layout

```
index.html                      the whole app
assets/                         what the page loads
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
