/*
 * Tests for the Linguae engine. No dependencies and no build: `node test.js`.
 *
 * The app ships as one HTML file, so there is nothing to import. This pulls the
 * script out of the page, runs it in a vm context against small stand-ins for
 * the browser, and reaches the top-level bindings through an export line
 * appended to the source — const and let do not land on the global object.
 *
 * What is worth testing here is the part that fails quietly: the review
 * schedule, the marking of a typed answer, and what a session does to crowns,
 * XP and hearts. A broken schedule still renders a perfectly good lesson.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

/* Anything built inside the vm carries that realm's prototypes, so
   deepStrictEqual rejects it even when the contents match. Compare the plain
   data instead. */
function eq(actual, expected, msg) {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, msg);
}

/* LINGUAE_PAGE points the suite at another copy of the page, which is how you
   check that it still bites: break something in a copy and run it against that. */
const PAGE = process.env.LINGUAE_PAGE || path.join(__dirname, "index.html");
const DAY = 86400000;

/* Written out rather than read from the app: a test that borrows the table it
   is checking agrees with any value the table happens to hold. */
const INTERVALS = [0, 1, 3, 7, 16, 35];

/* ---------- browser stand-ins ---------- */

function makeElement(tag) {
  const el = {
    tagName: (tag || "div").toUpperCase(),
    innerHTML: "",
    value: "",
    disabled: false,
    attrs: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    style: { setProperty() {} },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    focus() {},
    blur() {},
    click() {},
    scrollIntoView() {},
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
  return el;
}

function makeDom() {
  /* Tests write here to answer a typing exercise, the way a person would. */
  const byId = { app: makeElement("div") };
  const documentElement = makeElement("html");
  const document = {
    documentElement: documentElement,
    body: makeElement("body"),
    getElementById(id) {
      /* render() only sets innerHTML, so nothing is really created. The page
         always has the control it wires up, so hand back a stand-in and keep
         it, which is also how a typed answer survives until advance clears it. */
      if (!byId[id]) byId[id] = makeElement("div");
      return byId[id];
    },
    createElement(tag) { return makeElement(tag); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {}
  };
  return { document: document, byId: byId };
}

function makeStorage() {
  const map = new Map();
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    clear() { map.clear(); }
  };
}

/* ---------- loading the app ---------- */

function readScript() {
  const html = fs.readFileSync(PAGE, "utf8");
  const open = html.indexOf("<script>");
  const close = html.lastIndexOf("</script>");
  assert.ok(open > -1 && close > open, "index.html has no script block");
  return html.slice(open + "<script>".length, close);
}

const EXPORTS = `
;globalThis.__linguae = {
  COURSES: COURSES, LANGS: LANGS, BOX_DAYS: BOX_DAYS, DAILY_GOAL: DAILY_GOAL,
  norm: norm, loose: loose, lev: lev, words: words,
  today: today, dayDiff: dayDiff,
  gradeItem: gradeItem, srsOf: srsOf, dueItems: dueItems,
  addXp: addXp, touchStreak: touchStreak,
  crownsOf: crownsOf, unlocked: unlocked, course: course, prog: prog,
  pickKind: pickKind, makeExercise: makeExercise,
  buildLesson: buildLesson, buildPractice: buildPractice,
  practiceItems: practiceItems, pagePractice: pagePractice, PRACTICE_SETS: PRACTICE_SETS,
  startLesson: startLesson, startPractice: startPractice,
  submit: submit, advance: advance, tapPair: tapPair, optionIndexFor: optionIndexFor,
  endingFor: endingFor,
  hasVoiceFor: hasVoiceFor, voiceFor: voiceFor, speak: speak, choose: choose,
  AUDIO: AUDIO, clipFor: clipFor, sayItem: sayItem, canHear: canHear, FLAGS: FLAGS,
  courseHasAudio: courseHasAudio,
  pageAchievements: pageAchievements, pageProgress: pageProgress, achEarned: achEarned,
  state: function(){ return S; },
  session: function(){ return sess; },
  setActive: function(lg){ S.active = lg; }
};
`;

const SOURCE = readScript() + EXPORTS;

/* `voices` decides whether listening exercises can appear at all, and the app
   reads it once at load, so a run that needs audio loads its own copy. */
function loadApp(options) {
  const opts = options || {};
  const dom = makeDom();
  /* The app defers a few things — the word read after a right answer, the
     redraw after a mismatched pair. A no-op setTimeout would quietly drop
     them, so they queue here and a test runs them when it is ready. */
  const timers = [];
  const sandbox = {
    console: console,
    setTimeout(fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].fn = null; },
    document: dom.document,
    localStorage: makeStorage(),
    navigator: { language: "en-GB" }
  };
  const win = {
    matchMedia() { return { matches: false, addEventListener() {}, addListener() {} }; },
    scrollTo() {},
    addEventListener() {},
    removeEventListener() {}
  };
  const spoken = [];
  const played = [];
  /* Enough of Web Audio to see which notes a chime asks for. */
  const chimes = [];
  const param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} });
  /* opts.noWebAudio stands in for a browser without it at all. */
  if (!opts.noWebAudio) win.AudioContext = function () {
    return {
      state: "running",
      currentTime: 0,
      destination: {},
      resume() {},
      createGain: () => ({ gain: param(), connect() {} }),
      createBiquadFilter: () => ({ type: "", frequency: param(), connect() {} }),
      createOscillator: () => {
        const o = { type: "", frequency: param(), connect() {}, start() {}, stop() {} };
        o.frequency.setValueAtTime = (v) => chimes.push(Math.round(v));
        return o;
      }
    };
  };
  /* opts.noAudioElement stands in for a browser with no Audio at all, where
     even making the element throws. */
  if (!opts.noAudioElement) sandbox.Audio = function (src) {
    return {
      src: src || "",
      preload: "",
      currentTime: 0,
      onerror: null,
      pause() {},
      play() {
        played.push(this.src);
        /* opts.clipFails stands in for a listed clip that will not load. */
        if (opts.clipFails) {
          const fail = this.onerror;
          return { catch(f) { (f || fail)(); } };
        }
        return { catch() {} };
      }
    };
  };
  if (opts.voices) {
    win.speechSynthesis = {
      getVoices() { return opts.voices; },
      speak(u) { spoken.push(u); },
      cancel() {},
      addEventListener() {},
      onvoiceschanged: null
    };
    sandbox.SpeechSynthesisUtterance = function (text) { this.text = text; };
  }
  sandbox.window = win;
  sandbox.globalThis = sandbox;
  Object.assign(sandbox, win);

  const context = vm.createContext(sandbox);
  /* A fixed sequence, so a shuffle cannot make a test flap. */
  vm.runInContext(
    "var __s = 20260101;" +
    "Math.random = function(){ __s = (__s * 1103515245 + 12345) % 2147483648; return __s / 2147483648; };" +
    "globalThis.__reseed = function(n){ __s = n >>> 0 || 1; };",
    context
  );
  vm.runInContext(SOURCE, context, { filename: "index.html" });

  const api = sandbox.__linguae;
  api.reseed = sandbox.__reseed;
  api.answerBox = dom.byId;
  api.spoken = spoken;
  api.played = played;
  api.chimes = chimes;
  /* Run every callback waiting on a timer, in the order they were set. */
  api.runTimers = function () {
    timers.splice(0).forEach(function (t) { if (t.fn) t.fn(); });
  };
  api.sfxPlayed = function () {
    return played.filter(function (u) { return u.indexOf("assets/sfx/") === 0; });
  };
  api.clipsPlayed = function () {
    return played.filter(function (u) { return u.indexOf("assets/audio/") === 0; });
  };
  /* Stands in for the manifest, which arrives over fetch in a browser. */
  api.addClips = function (ids, format) {
    if (format) api.AUDIO.format = format;
    ids.forEach(function (id) {
      api.AUDIO.have[id] = true;
      const lg = id.split("-")[0];
      api.AUDIO.byLang[lg] = (api.AUDIO.byLang[lg] || 0) + 1;
    });
  };
  api.typeAnswer = function (text) {
    const el = makeElement("textarea");
    el.value = text;
    dom.byId.answer = el;
  };
  return api;
}

/* ---------- a runner ---------- */

const results = [];
let only = process.argv[2] || null;

function test(name, fn) {
  if (only && name.indexOf(only) === -1) return;
  try {
    fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    results.push({ name: name, ok: false, err: err });
  }
}

/* ---------- normalising an answer ---------- */

const app = loadApp();

test("norm strips accents, case and punctuation", function () {
  assert.strictEqual(app.norm("¿Cómo estás?"), "como estas");
  assert.strictEqual(app.norm("  Él  está   aquí. "), "el esta aqui");
  assert.strictEqual(app.norm("C'est l'eau !"), "c'est l'eau");
});

test("norm folds the German sharp s and curly apostrophes", function () {
  assert.strictEqual(app.norm("Straße"), "strasse");
  assert.strictEqual(app.norm("l’eau"), "l'eau");
});

test("loose drops apostrophes and spacing", function () {
  assert.strictEqual(app.loose("C'est l'eau"), "cestleau");
  assert.strictEqual(app.loose("de nada"), "denada");
});

test("lev counts single edits", function () {
  assert.strictEqual(app.lev("gato", "gato"), 0);
  assert.strictEqual(app.lev("gato", "gata"), 1);
  assert.strictEqual(app.lev("gato", "gatos"), 1);
  assert.strictEqual(app.lev("", "abc"), 3);
});

test("words keeps inner apostrophes and drops surrounding marks", function () {
  eq(app.words("¿Cómo estás, tú?"), ["Cómo", "estás", "tú"]);
  eq(app.words("C'est l'eau !"), ["C'est", "l'eau"]);
});

/* ---------- the review schedule ---------- */

function freshSrs(a, lang) {
  a.setActive(lang || "es");
  a.prog().srs = {};
  a.prog().crowns = {};
  a.prog().xp = 0;
  return a.course().items[0].id;
}

test("the box intervals are the ones the course promises", function () {
  eq(loadApp().BOX_DAYS, INTERVALS);
});

test("a correct answer climbs one box and waits the box's interval", function () {
  const a = loadApp();
  const id = freshSrs(a);
  const before = Date.now();
  a.gradeItem(id, true);
  const r = a.srsOf(id);
  assert.strictEqual(r.box, 1);
  assert.strictEqual(r.seen, 1);
  assert.strictEqual(r.wrong, 0);
  const waited = r.due - before;
  assert.ok(Math.abs(waited - INTERVALS[1] * DAY) < 2000, "expected a one-day wait, got " + waited);
});

test("the boxes run 1, 3, 7, 16 and 35 days and stop at five", function () {
  const a = loadApp();
  const id = freshSrs(a);
  [1, 2, 3, 4, 5].forEach(function (box) {
    const before = Date.now();
    a.gradeItem(id, true);
    const r = a.srsOf(id);
    assert.strictEqual(r.box, box);
    assert.ok(Math.abs((r.due - before) - INTERVALS[box] * DAY) < 2000,
      "box " + box + " should wait " + INTERVALS[box] + " days");
  });
  a.gradeItem(id, true);
  assert.strictEqual(a.srsOf(id).box, 5, "box 5 is the ceiling");
  assert.strictEqual(a.srsOf(id).seen, 6);
});

test("a wrong answer drops two boxes and comes back in ten minutes", function () {
  const a = loadApp();
  const id = freshSrs(a);
  a.gradeItem(id, true);
  a.gradeItem(id, true);
  a.gradeItem(id, true);
  assert.strictEqual(a.srsOf(id).box, 3);
  const before = Date.now();
  a.gradeItem(id, false);
  const r = a.srsOf(id);
  assert.strictEqual(r.box, 1, "three minus two");
  assert.strictEqual(r.wrong, 1);
  assert.ok(Math.abs((r.due - before) - 10 * 60000) < 2000, "expected ten minutes, got " + (r.due - before));
});

test("the drop stops at box zero", function () {
  const a = loadApp();
  const id = freshSrs(a);
  a.gradeItem(id, false);
  assert.strictEqual(a.srsOf(id).box, 0);
  a.gradeItem(id, false);
  assert.strictEqual(a.srsOf(id).box, 0);
  assert.strictEqual(a.srsOf(id).wrong, 2);
});

test("only items that are seen and ripe come up for review", function () {
  const a = loadApp();
  freshSrs(a);
  const items = a.course().items;
  a.prog().srs[items[0].id] = { box: 1, due: Date.now() - 1000, seen: 2, wrong: 0 };
  a.prog().srs[items[1].id] = { box: 1, due: Date.now() + DAY, seen: 2, wrong: 0 };
  a.prog().srs[items[2].id] = { box: 0, due: 0, seen: 0, wrong: 0 };
  const due = a.dueItems().map(function (x) { return x.id; });
  eq(due, [items[0].id], "only the ripe, already-seen item");
});

/* ---------- unlocking ---------- */

test("a lesson opens once the one before it has a crown", function () {
  const a = loadApp();
  freshSrs(a);
  const lessons = a.course().lessons;
  assert.ok(a.unlocked(lessons[0].id), "the first lesson is always open");
  assert.ok(!a.unlocked(lessons[1].id), "the second starts locked");
  a.prog().crowns[lessons[0].id] = 1;
  assert.ok(a.unlocked(lessons[1].id), "a crown opens the next one");
  assert.ok(!a.unlocked(lessons[2].id), "and only the next one");
});

/* ---------- building exercises ---------- */

test("a multiple choice has four options, one of them right", function () {
  const a = loadApp();
  freshSrs(a);
  const c = a.course();
  const item = c.items[0];
  for (let i = 0; i < 40; i++) {
    const ex = a.makeExercise(item, 0, c, false);
    if (ex.kind !== "pick_tgt" && ex.kind !== "pick_en") continue;
    assert.strictEqual(ex.options.length, 4);
    assert.strictEqual(ex.answer, item.id);
    const ids = ex.options.map(function (o) { return o.id; });
    assert.ok(ids.indexOf(item.id) > -1, "the right answer must be among the options");
    assert.strictEqual(new Set(ids).size, 4, "no option repeats");
    ex.options.forEach(function (o) {
      assert.strictEqual(o.kind, item.kind, "distractors come from the same kind of item");
    });
  }
});

test("a word bank holds every part plus some decoys", function () {
  const a = loadApp();
  freshSrs(a);
  const c = a.course();
  const phrase = c.items.filter(function (x) {
    return x.kind === "p" && (x.bank || a.words(x.tgt).length >= 3);
  })[0];
  assert.ok(phrase, "no phrase in this course can be built from a word bank");
  let built = 0;
  for (let i = 0; i < 60; i++) {
    const ex = a.makeExercise(phrase, 2, c, false);
    if (ex.kind !== "bank") continue;
    built++;
    assert.ok(Array.isArray(ex.parts) && ex.parts.length > 0, "parts are missing");
    assert.ok(Array.isArray(ex.tiles), "tiles are missing");
    ex.parts.forEach(function (p) {
      assert.ok(ex.tiles.indexOf(p) > -1, "every part must be on a tile: " + p);
    });
    assert.ok(ex.tiles.length > ex.parts.length, "a bank with no decoy answers itself");
  }
  assert.ok(built > 0, "no bank exercise was built for a phrase");
});

test("listening is off without a voice and on with one", function () {
  const silent = loadApp();
  freshSrs(silent);
  assert.strictEqual(silent.hasVoiceFor("es-ES"), false);
  for (let i = 0; i < 80; i++) {
    const ex = silent.makeExercise(silent.course().items[0], 2, silent.course(), false);
    assert.notStrictEqual(ex.kind, "listen", "no voice, no listening exercise");
  }

  const loud = loadApp({ voices: [{ lang: "es-ES", name: "Test" }] });
  freshSrs(loud);
  assert.strictEqual(loud.hasVoiceFor("es-ES"), true);
  assert.strictEqual(loud.hasVoiceFor("la-LA"), false, "an uninstalled language has no voice");
  let heard = false;
  for (let i = 0; i < 200 && !heard; i++) {
    heard = loud.makeExercise(loud.course().items[0], 2, loud.course(), true).kind === "listen";
  }
  assert.ok(heard, "with a voice installed, listening should come up");
});

test("a vocabulary lesson opens with a five-pair match, a phrase lesson does not", function () {
  const a = loadApp();
  freshSrs(a);
  const c = a.course();
  const vocab = c.lessons.filter(function (l) { return l.kind === "w"; })[0];
  const phrases = c.lessons.filter(function (l) { return l.kind === "p"; })[0];

  const first = a.buildLesson(vocab, c, 0)[0];
  assert.strictEqual(first.kind, "match");
  assert.strictEqual(first.pairs.length, 5);
  assert.strictEqual(new Set(first.pairs.map(function (p) { return p.id; })).size, 5);

  assert.notStrictEqual(a.buildLesson(phrases, c, 0)[0].kind, "match");
});

/* ---------- choosing a voice ---------- */

const LEGACY_FR = { name: "Microsoft Hortense - French (France)", lang: "fr-FR", localService: true };
const NEURAL_FR = { name: "Microsoft Denise Online (Natural) - French (France)", lang: "fr-FR", localService: false };
const GOOGLE_FR = { name: "Google français", lang: "fr-FR", localService: false };
const CANADA_FR = { name: "Microsoft Claude - French (Canada)", lang: "fr-CA", localService: true };
const BRAZIL_PT = { name: "Microsoft Daniel - Portuguese (Brazil)", lang: "pt-BR", localService: true, default: true };

test("a neural or Google voice wins over the legacy one", function () {
  const a = loadApp({ voices: [LEGACY_FR, NEURAL_FR] });
  assert.strictEqual(a.voiceFor("fr-FR").name, NEURAL_FR.name);

  const b = loadApp({ voices: [LEGACY_FR, GOOGLE_FR] });
  assert.strictEqual(b.voiceFor("fr-FR").name, GOOGLE_FR.name);
});

test("the name alone is enough to prefer a better voice", function () {
  /* Same language, same region, both local: only the name tells them apart. */
  const natural = { name: "Microsoft Denise (Natural) - French (France)", lang: "fr-FR", localService: true };
  const google = { name: "Google français", lang: "fr-FR", localService: true };
  assert.strictEqual(loadApp({ voices: [LEGACY_FR, natural] }).voiceFor("fr-FR").name, natural.name);
  assert.strictEqual(loadApp({ voices: [LEGACY_FR, google] }).voiceFor("fr-FR").name, google.name);
  assert.strictEqual(loadApp({ voices: [natural, LEGACY_FR] }).voiceFor("fr-FR").name, natural.name,
    "and the order they are installed in makes no difference");
});

test("the asked-for region wins over another one", function () {
  const a = loadApp({ voices: [CANADA_FR, LEGACY_FR] });
  assert.strictEqual(a.voiceFor("fr-FR").name, LEGACY_FR.name, "fr-FR over fr-CA");
  const b = loadApp({ voices: [CANADA_FR] });
  assert.strictEqual(b.voiceFor("fr-FR").name, CANADA_FR.name, "another region still beats silence");
});

test("a voice is never borrowed from another language", function () {
  const a = loadApp({ voices: [BRAZIL_PT] });
  assert.strictEqual(a.voiceFor("fr-FR"), null);
  assert.strictEqual(a.hasVoiceFor("fr-FR"), false);
  assert.strictEqual(a.voiceFor("pt-BR").name, BRAZIL_PT.name, "its own language still works");
});

test("French is left silent rather than read by a Portuguese voice", function () {
  const a = loadApp({ voices: [BRAZIL_PT] });
  a.speak("bonjour", "fr-FR");
  assert.strictEqual(a.spoken.length, 0, "nothing should be spoken without a French voice");
  a.speak("bom dia", "pt-BR");
  assert.strictEqual(a.spoken.length, 1, "and Portuguese still speaks");
});

test("speech runs at the natural rate, on the chosen voice", function () {
  const a = loadApp({ voices: [LEGACY_FR, NEURAL_FR] });
  a.speak("bonjour", "fr-FR");
  assert.strictEqual(a.spoken.length, 1);
  const u = a.spoken[0];
  assert.strictEqual(u.text, "bonjour");
  assert.strictEqual(u.rate, 1, "0.88 was the drawl");
  assert.strictEqual(u.voice.name, NEURAL_FR.name);
  assert.strictEqual(u.lang, "fr-FR");
});

test("checking an answer plays the sound and says nothing", function () {
  const a = loadApp({ voices: [BRAZIL_PT, NEURAL_FR] });
  a.setActive("fr");
  a.addClips(a.course().items.map(function (it) { return it.id; }));
  a.prog().srs = {}; a.prog().crowns = {}; a.prog().xp = 0;
  const lesson = a.course().lessons[0];
  a.startLesson(lesson);
  while (a.session().queue[a.session().idx].kind === "match") {
    answerCurrent(a, true);
    a.advance();
  }
  a.spoken.length = 0;
  a.played.length = 0;
  answerCurrent(a, true);
  assert.ok(a.sfxPlayed().length > 0, "the right-answer sound still fires");
  assert.strictEqual(a.spoken.length, 0, "the word is not read out again");
  eq(a.clipsPlayed(), [], "nor is its recording replayed");
  /* And nothing is waiting on a timer to do it a moment later. */
  a.runTimers();
  assert.strictEqual(a.spoken.length, 0, "not after a wait either");
  eq(a.clipsPlayed(), []);
});

test("picking an option plays it, but only where the options are the language", function () {
  const a = loadApp({ voices: [NEURAL_FR] });
  a.setActive("fr");
  const c = a.course();
  a.addClips(c.items.map(function (it) { return it.id; }));
  const seen = {};
  ["pick_tgt", "pick_en", "listen"].forEach(function (kind) {
    /* Reach the kind by playing until it turns up: `choose` works on the
       session, which is how a tap reaches it in the page. */
    for (let guard = 0; guard < 400; guard++) {
      freshSrs(a, "fr");
      a.startLesson(c.lessons[guard % c.lessons.length]);
      const s = a.session();
      while (s.idx < s.queue.length) {
        const ex = s.queue[s.idx];
        if (ex.kind === kind) {
          const html = a.answerBox.app.innerHTML;
          const speakers = (html.match(/data-item=/g) || []).length;
          if (kind === "pick_tgt") {
            assert.strictEqual(speakers, 0,
              "the option is the button that plays it; nothing beside it");
          } else {
            assert.strictEqual(speakers, 1, kind + ": the question keeps its own speaker");
          }

          /* A wrong option, so reading the prompt out instead of the option
             tapped would be caught rather than look the same. */
          const other = ex.options.filter(function (o) { return o.id !== ex.answer; })[0];
          a.spoken.length = 0;
          a.played.length = 0;
          a.choose(other.id);
          assert.strictEqual(s.sel, other.id, kind + ": the tap must still select");
          if (kind === "pick_tgt") {
            eq(a.clipsPlayed(), ["assets/audio/fr/" + other.id + ".mp3"],
              "what plays is the option that was tapped");
          } else {
            assert.strictEqual(a.spoken.length, 0, kind + ": an English option spoke");
            eq(a.played, [], kind + ": an English option played a recording");
          }
          seen[kind] = true;
          return;
        }
        answerCurrent(a, true);
        a.advance();
      }
    }
  });
  eq(seen, { pick_tgt: true, pick_en: true, listen: true }, "a kind never came up");
});

/* ---------- what a course is taught from ---------- */

test("a course says which language it is taught from", function () {
  const a = loadApp();
  a.LANGS.forEach(function (lg) {
    const c = a.COURSES[lg];
    if (lg === "en") {
      assert.strictEqual(c.from, "Portuguese", "English is the one taught from Portuguese");
    } else {
      assert.strictEqual(c.from, undefined, lg + " is taught from English, which is the default");
    }
  });
});

test("the English course puts Portuguese on the known side", function () {
  const a = loadApp();
  const c = a.COURSES.en;
  assert.strictEqual(c.tts, "en-US", "the audio is the language being learnt");
  /* The prompt side is Portuguese, the answer side is English, and the two
     must not be swapped — the accented words are the giveaway. */
  const first = c.items[0];
  assert.strictEqual(first.en, "olá");
  assert.strictEqual(first.tgt, "hello");
  const accented = c.items.filter(function (it) { return /[áâãàéêíóôõúç]/i.test(it.en); });
  assert.ok(accented.length > 10, "the Portuguese side should carry its accents");
});

/* ---------- Russian, the first course with a romanisation ---------- */

test("every Russian item carries a romanisation", function () {
  const a = loadApp();
  const items = a.COURSES.ru.items;
  assert.strictEqual(items.length, 112);
  items.forEach(function (it) {
    assert.ok(it.rom && it.rom.trim(), it.id + " (" + it.en + ") has no romanisation");
    assert.ok(/[\u0400-\u04FF]/.test(it.tgt), it.id + " is not written in Cyrillic");
    assert.ok(!/[\u0400-\u04FF]/.test(it.rom), it.id + " has Cyrillic in its romanisation");
  });
});

test("a Russian answer is accepted in Cyrillic or in its romanisation", function () {
  const a = loadApp({ voices: [NEURAL_FR] });
  a.setActive("ru");
  a.prog().srs = {}; a.prog().crowns = {}; a.prog().xp = 0;
  const item = a.course().items[0];

  typingSession(a, item);
  a.typeAnswer(item.tgt);
  a.submit();
  assert.strictEqual(a.session().lastOk, true, "the Cyrillic spelling");

  typingSession(a, item);
  a.typeAnswer(item.rom);
  a.submit();
  assert.strictEqual(a.session().lastOk, true, "the romanised reading: " + item.rom);

  typingSession(a, item);
  a.typeAnswer("qqqqqqqq");
  a.submit();
  assert.strictEqual(a.session().lastOk, false);
});

test("every course has a flag drawn for it", function () {
  const a = loadApp();
  a.LANGS.forEach(function (lg) {
    const svg = a.FLAGS[lg];
    assert.ok(svg, "no flag for " + lg);
    assert.ok(svg.indexOf("<svg") === 0 && svg.indexOf("</svg>") > 0, lg + "'s flag is not an svg");
    const box = (svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/) || []).slice(1);
    assert.strictEqual(box.length, 2, lg + "'s flag has no viewBox starting at the origin");
    assert.strictEqual(box[0], box[1], lg + "'s flag is not square: " + box.join("x"));
  });
});

/* ---------- recorded clips ---------- */

test("a clip's address is built from the item's own id", function () {
  const a = loadApp({ voices: [NEURAL_FR] });
  a.setActive("fr");
  const item = a.course().items[0];
  assert.strictEqual(a.clipFor(item), null, "nothing is recorded yet");
  a.addClips([item.id]);
  assert.strictEqual(a.clipFor(item), "assets/audio/fr/" + item.id + ".mp3");
  a.AUDIO.format = "wav";
  assert.strictEqual(a.clipFor(item), "assets/audio/fr/" + item.id + ".wav",
    "the manifest decides the format");
});

test("a clip is played in place of the voice, and only where there is one", function () {
  const a = loadApp({ voices: [NEURAL_FR] });
  a.setActive("fr");
  const items = a.course().items;
  a.addClips([items[0].id]);

  a.sayItem(items[0], "fr-FR");
  eq(a.played, ["assets/audio/fr/" + items[0].id + ".mp3"]);
  assert.strictEqual(a.spoken.length, 0, "the voice should not also fire");

  a.sayItem(items[1], "fr-FR");
  assert.strictEqual(a.played.length, 1, "no clip for this one");
  assert.strictEqual(a.spoken.length, 1, "so the voice takes it");
  assert.strictEqual(a.spoken[0].text, items[1].tgt);
});

test("a listed clip that will not load falls back to the voice", function () {
  const a = loadApp({ voices: [NEURAL_FR], clipFails: true });
  a.setActive("fr");
  const item = a.course().items[0];
  a.addClips([item.id]);

  a.sayItem(item, "fr-FR");
  assert.strictEqual(a.played.length, 1, "it still tries the clip first");
  assert.strictEqual(a.spoken.length, 1, "and the voice picks up when the clip fails");
  assert.strictEqual(a.spoken[0].text, item.tgt);
});

test("a clip gives a language audio even with no voice installed", function () {
  /* The point of the whole feature: this machine has no French voice. */
  const a = loadApp({ voices: [BRAZIL_PT] });
  a.setActive("fr");
  const c = a.course();
  const items = c.items;
  assert.strictEqual(a.hasVoiceFor(c.tts), false);
  assert.strictEqual(a.courseHasAudio(c), false, "nothing to hear yet");

  a.addClips([items[0].id]);
  assert.strictEqual(a.canHear(items[0], c.tts), true, "the recorded one can be heard");
  assert.strictEqual(a.canHear(items[1], c.tts), false, "the rest still cannot");
  assert.strictEqual(a.courseHasAudio(c), true);

  a.sayItem(items[0], c.tts);
  eq(a.played, ["assets/audio/fr/" + items[0].id + ".mp3"]);
  assert.strictEqual(a.spoken.length, 0, "and never through the Portuguese voice");
});

test("a listening exercise follows the audio, clip or voice", function () {
  const a = loadApp({ voices: [BRAZIL_PT] });
  a.setActive("fr");
  const c = a.course();
  const item = c.items[0];

  for (let i = 0; i < 80; i++) {
    assert.notStrictEqual(a.makeExercise(item, 2, c, a.canHear(item, c.tts)).kind, "listen",
      "no audio, no listening exercise");
  }
  a.addClips([item.id]);
  let heard = false;
  for (let i = 0; i < 200 && !heard; i++) {
    heard = a.makeExercise(item, 2, c, a.canHear(item, c.tts)).kind === "listen";
  }
  assert.ok(heard, "a clip should let listening come up");
});

test("a lesson only asks you to listen to what can be heard", function () {
  const a = loadApp({ voices: [BRAZIL_PT] });
  a.setActive("fr");
  const c = a.course();
  const lesson = c.lessons[0];
  a.addClips([lesson.items[0].id]);
  let listens = 0;
  for (let round = 0; round < 40; round++) {
    a.buildLesson(lesson, c, 2).forEach(function (ex) {
      if (ex.kind !== "listen") return;
      listens++;
      assert.ok(a.clipFor(ex.item), "listening was built for " + ex.item.id + ", which has no audio");
    });
  }
  assert.ok(listens > 0, "the one recorded word should still come up to listen to");
});

/* ---------- the chimes ---------- */

test("checking an answer plays the recording for the outcome", function () {
  const a = loadApp({ voices: [NEURAL_FR] });
  freshSrs(a, "fr");
  const item = a.course().items[0];

  typingSession(a, item);
  a.typeAnswer(item.tgt);
  a.played.length = 0;
  a.submit();
  eq(a.sfxPlayed(), ["assets/sfx/correct_answer.opus"]);

  typingSession(a, item);
  a.typeAnswer("qqqqqqqq");
  a.played.length = 0;
  a.submit();
  eq(a.sfxPlayed(), ["assets/sfx/incorrect_answer.opus"]);
});

test("the oscillators take over when the recording will not play", function () {
  const a = loadApp({ voices: [NEURAL_FR], clipFails: true });
  freshSrs(a, "fr");
  const item = a.course().items[0];

  typingSession(a, item);
  a.typeAnswer(item.tgt);
  a.chimes.length = 0;
  a.submit();
  const right = a.chimes.slice();
  assert.ok(right.length >= 2, "a right answer should still ring");

  typingSession(a, item);
  a.typeAnswer("qqqqqqqq");
  a.chimes.length = 0;
  a.submit();
  const wrong = a.chimes.slice();
  assert.ok(wrong.length >= 1, "and a wrong one should still sound");

  assert.notDeepStrictEqual(right, wrong, "the two must not be the same sound");
  assert.ok(Math.min.apply(null, right) > Math.max.apply(null, wrong),
    "right rings above wrong: " + right.join(",") + " vs " + wrong.join(","));
  assert.ok(right[1] > right[0], "and it rises");
});

test("with no Audio element at all, the oscillators still answer", function () {
  const a = loadApp({ voices: [NEURAL_FR], noAudioElement: true });
  freshSrs(a, "fr");
  const item = a.course().items[0];

  typingSession(a, item);
  a.typeAnswer(item.tgt);
  a.chimes.length = 0;
  a.submit();
  assert.ok(a.chimes.length >= 2, "making the element threw, so the chime must cover it");
  assert.strictEqual(a.played.length, 0, "and nothing was handed to an element");
});

test("the ending depends on how much was missed, not on whether anything was", function () {
  const a = loadApp();
  /* Three is written out rather than read from the app: a test that borrows
     the line it is checking agrees with wherever the line happens to be. */
  assert.strictEqual(a.endingFor(0), "finished_correct");
  [1, 2, 3].forEach(function (m) {
    assert.strictEqual(a.endingFor(m), "finished_mid", m + " missed is still a good run");
  });
  [4, 5, 7, 20].forEach(function (m) {
    assert.strictEqual(a.endingFor(m), "finished_incorrect", m + " missed is not");
  });
});

test("finishing a lesson sounds, and says how it went", function () {
  const a = loadApp({ voices: [NEURAL_FR] });

  freshSrs(a, "fr");
  a.played.length = 0;
  const clean = playLesson(a);
  assert.strictEqual(clean.session.mistakes, 0);
  eq(a.sfxPlayed().filter(function (u) { return u.indexOf("finished") > -1; }),
     ["assets/sfx/finished_correct.opus"], "a clean lesson ends on the clean sound");

  /* One slip is not a bad lesson, and used to sound like one. */
  freshSrs(a, "fr");
  a.played.length = 0;
  const slip = playLesson(a, { wrongAt: 1 });
  assert.strictEqual(slip.session.mistakes, 1);
  eq(a.sfxPlayed().filter(function (u) { return u.indexOf("finished") > -1; }),
     ["assets/sfx/finished_mid.opus"], "one miss ends in the middle");
});

test("a run with more misses than are forgiven ends on the low sound", function () {
  const a = loadApp({ voices: [NEURAL_FR] });
  freshSrs(a, "fr");
  playLesson(a);
  /* Practice, where hearts are not at stake, is the only place a session can
     take more than four misses and still reach the end. */
  Object.keys(a.prog().srs).forEach(function (id) { a.prog().srs[id].due = Date.now() - 1000; });
  a.played.length = 0;
  a.startPractice("due");
  /* A miss sends the word back to the end of the queue, so a session answered
     wrong all the way through never finishes. Five, then the rest right. */
  let guard = 0, missed = 0;
  while (a.session().state !== "done") {
    if (guard++ > 200) throw new Error("the review never ended");
    answerCurrent(a, missed >= 5);
    if (missed < 5) missed++;
    a.advance();
  }
  assert.strictEqual(a.session().mistakes, 5, "more misses than are forgiven");
  eq(a.sfxPlayed().filter(function (u) { return u.indexOf("finished") > -1; }),
     ["assets/sfx/finished_incorrect.opus"]);
});

test("a lesson still runs where the browser has neither sound", function () {
  const a = loadApp({ noWebAudio: true, clipFails: true });
  freshSrs(a, "fr");
  const run = playLesson(a);
  assert.strictEqual(run.session.state, "done");
  assert.strictEqual(a.chimes.length, 0, "nothing was played, and nothing threw");
});

/* ---------- a session from end to end ---------- */

function answerCurrent(a, correct) {
  const s = a.session();
  const ex = s.queue[s.idx];
  if (ex.kind === "match") {
    ex.pairs.forEach(function (p) {
      a.tapPair(fakePair("en", p.id), ex);
      a.tapPair(fakePair("tgt", p.id), ex);
    });
    return;
  }
  if (ex.kind === "pick_tgt" || ex.kind === "pick_en" || ex.kind === "listen") {
    s.sel = correct ? ex.answer : ex.options.filter(function (o) { return o.id !== ex.answer; })[0].id;
  } else if (ex.kind === "bank") {
    s.used = correct ? ex.parts.slice() : ex.parts.slice().reverse().concat("zzz");
  } else {
    a.typeAnswer(correct ? ex.item.tgt : "qqqqqq");
  }
  a.submit();
}

function fakePair(side, id) {
  return {
    getAttribute(k) { return k === "data-side" ? side : k === "data-id" ? id : null; },
    classList: { add() {}, remove() {} }
  };
}

function playLesson(a, opts) {
  const o = opts || {};
  const lesson = a.course().lessons[0];
  a.startLesson(lesson);
  let guard = 0;
  while (a.session() && a.session().state !== "done" && a.session().state !== "dead") {
    if (guard++ > 200) throw new Error("the session never ended");
    const n = a.session().answered;
    const miss = (o.wrongAt !== undefined && n === o.wrongAt)
              || (o.wrongWhile !== undefined && n < o.wrongWhile);
    answerCurrent(a, !miss);
    if (a.session().state === "dead") break;
    a.advance();
  }
  return { lesson: lesson, session: a.session() };
}

/* The kind of exercise is drawn at random, so a typing test plants its own. */
function typingSession(a, item) {
  a.startLesson(a.course().lessons[0]);
  const s = a.session();
  s.queue[s.idx] = { id: item.id, item: item, kind: "write" };
  return s;
}

test("a typed answer is marked past accents and punctuation", function () {
  const a = loadApp();
  freshSrs(a);
  const item = a.course().items.filter(function (x) { return /[áéíóúñü]/i.test(x.tgt); })[0];
  assert.ok(item, "this course has nothing accented to test with");

  typingSession(a, item);
  a.typeAnswer(item.tgt);
  a.submit();
  assert.strictEqual(a.session().lastOk, true, "the exact answer");

  typingSession(a, item);
  a.typeAnswer(a.norm(item.tgt) + "!");
  a.submit();
  assert.strictEqual(a.session().lastOk, true, "the same answer without its accents");
});

test("a one-letter slip passes, and says so; a wrong word does not", function () {
  const a = loadApp();
  freshSrs(a);
  const item = a.course().items.filter(function (x) { return a.norm(x.tgt).length > 5; })[0];

  const typo = item.tgt.slice(0, -1) + (item.tgt.slice(-1) === "x" ? "y" : "x");
  typingSession(a, item);
  a.typeAnswer(typo);
  a.submit();
  assert.strictEqual(a.session().lastOk, true, "one letter off should still count");
  assert.strictEqual(a.session().typo, true, "and the lesson should flag the spelling");

  typingSession(a, item);
  a.typeAnswer("qwertyuiop");
  a.submit();
  assert.strictEqual(a.session().lastOk, false, "a different word is simply wrong");
  assert.strictEqual(a.session().hearts, 4, "and it costs a heart");
});

test("an empty answer is never right", function () {
  const a = loadApp();
  freshSrs(a);
  const item = a.course().items[0];
  typingSession(a, item);
  a.typeAnswer("");
  a.submit();
  assert.strictEqual(a.session().lastOk, false);
});

test("a clean lesson earns a crown and fifteen XP", function () {
  const a = loadApp();
  freshSrs(a);
  const run = playLesson(a);
  assert.strictEqual(run.session.state, "done");
  assert.strictEqual(run.session.mistakes, 0);
  assert.strictEqual(a.crownsOf(run.lesson.id), 1, "one crown for one pass");
  assert.strictEqual(run.session.gained, 15, "ten, plus five for a clean run");
  assert.strictEqual(a.prog().xp, 15);
  assert.strictEqual(a.state().streak, 1, "the first lesson starts the streak");
});

test("a mistake costs a heart, the bonus, and sends the word back to the end", function () {
  const a = loadApp();
  freshSrs(a);
  const lesson = a.course().lessons[0];
  a.startLesson(lesson);

  /* Walk to the first exercise that has an item of its own. */
  while (a.session().queue[a.session().idx].kind === "match") {
    answerCurrent(a, true);
    a.advance();
  }
  const before = a.session().queue.length;
  const missed = a.session().queue[a.session().idx].item.id;
  answerCurrent(a, false);

  const s = a.session();
  assert.strictEqual(s.lastOk, false);
  assert.strictEqual(s.hearts, 4, "a wrong answer costs one heart");
  assert.strictEqual(s.mistakes, 1);
  assert.strictEqual(s.queue.length, before + 1, "the missed word is queued again");

  const retry = s.queue[s.queue.length - 1];
  assert.strictEqual(retry.item.id, missed);
  assert.ok(retry.retry, "the repeat is flagged as one");
  if (retry.kind === "bank") {
    assert.ok(Array.isArray(retry.parts) && Array.isArray(retry.tiles),
      "a repeat built as a word bank still needs its parts and tiles");
  }
  if (retry.kind === "pick_tgt" || retry.kind === "pick_en" || retry.kind === "listen") {
    assert.strictEqual(retry.options.length, 4, "a repeat still needs its options");
  }
});

test("five mistakes end the lesson and leave no crown", function () {
  const a = loadApp();
  freshSrs(a);
  const lesson = a.course().lessons[0];
  a.startLesson(lesson);
  let guard = 0;
  while (a.session().state !== "dead") {
    if (guard++ > 200) throw new Error("hearts never ran out");
    if (a.session().queue[a.session().idx].kind === "match") {
      answerCurrent(a, true);
      a.advance();
      continue;
    }
    answerCurrent(a, false);
    if (a.session().state === "dead") break;
    a.advance();
  }
  assert.strictEqual(a.session().hearts, 0);
  assert.strictEqual(a.session().mistakes, 5);
  assert.strictEqual(a.crownsOf(lesson.id), 0, "a failed lesson grants nothing");
  assert.strictEqual(a.prog().xp, 0);
});

test("advance clears what the last exercise left behind", function () {
  const a = loadApp();
  freshSrs(a);
  const lesson = a.course().lessons[0];
  a.startLesson(lesson);
  answerCurrent(a, true);
  a.advance();
  const s = a.session();
  assert.strictEqual(s.sel, null);
  eq(s.used, []);
  eq(s.matched, [], "a stale match list would show the next pairs as solved");
  assert.strictEqual(s.picked, null);
  assert.strictEqual(s.given, "");
  assert.strictEqual(s.state, "ask");
});

test("a lesson can be crowned five times and no more", function () {
  const a = loadApp();
  freshSrs(a);
  let lesson;
  for (let i = 0; i < 7; i++) lesson = playLesson(a).lesson;
  assert.strictEqual(a.crownsOf(lesson.id), 5, "five crowns is the ceiling");
});

test("matching a pair grades it right, a mismatch grades both wrong", function () {
  const a = loadApp();
  freshSrs(a);
  const lesson = a.course().lessons.filter(function (l) { return l.kind === "w"; })[0];
  a.startLesson(lesson);
  const ex = a.session().queue[0];
  assert.strictEqual(ex.kind, "match");

  const first = ex.pairs[0].id, second = ex.pairs[1].id;
  a.tapPair(fakePair("en", first), ex);
  a.tapPair(fakePair("tgt", second), ex);
  assert.strictEqual(a.srsOf(first).wrong, 1, "a mismatch counts against both words");
  assert.strictEqual(a.srsOf(second).wrong, 1);
  eq(a.session().matched, [], "nothing is matched yet");

  a.tapPair(fakePair("en", first), ex);
  a.tapPair(fakePair("tgt", first), ex);
  eq(a.session().matched, [first]);
  assert.strictEqual(a.srsOf(first).box, 1, "the pair that landed moves up a box");

  ex.pairs.slice(1).forEach(function (p) {
    a.tapPair(fakePair("en", p.id), ex);
    a.tapPair(fakePair("tgt", p.id), ex);
  });
  assert.strictEqual(a.session().matched.length, 5);
  assert.strictEqual(a.session().state, "feedback", "the last pair closes the exercise");
});

function openMatch(a) {
  freshSrs(a, "fr");
  const lesson = a.course().lessons.filter(function (l) { return l.kind === "w"; })[0];
  a.startLesson(lesson);
  const ex = a.session().queue[0];
  assert.strictEqual(ex.kind, "match", "a vocabulary lesson opens on a match");
  return ex;
}

test("the letters shown on the options pick them, and nothing else does", function () {
  const a = loadApp();
  eq(["a", "b", "c", "d", "A", "D"].map(function (k) { return a.optionIndexFor(k); }),
     [0, 1, 2, 3, 0, 3], "A to D, upper or lower");
  /* The options are lettered on screen, so a digit is a key the page never
     offers; it used to select one all the same. */
  ["1", "2", "3", "4", "0", "5", "e", "z", "Enter", " ", "ArrowDown"].forEach(function (k) {
    assert.strictEqual(a.optionIndexFor(k), -1, JSON.stringify(k) + " should pick nothing");
  });
});

test("a mismatched pair costs a heart and marks the lesson", function () {
  const a = loadApp();
  const ex = openMatch(a);
  const s = a.session();
  assert.strictEqual(s.hearts, 5, "a lesson opens with five");

  a.tapPair(fakePair("en", ex.pairs[0].id), ex);
  a.tapPair(fakePair("tgt", ex.pairs[1].id), ex);
  assert.strictEqual(s.hearts, 4, "a pair that does not match costs one");
  assert.strictEqual(s.mistakes, 1, "one tap is one mistake, though both words go back");

  /* A match that lands costs nothing. */
  a.tapPair(fakePair("en", ex.pairs[0].id), ex);
  a.tapPair(fakePair("tgt", ex.pairs[0].id), ex);
  assert.strictEqual(s.hearts, 4);
  assert.strictEqual(s.mistakes, 1);
});

test("five mismatched pairs end the lesson, the same as five wrong answers", function () {
  const a = loadApp();
  const ex = openMatch(a);
  const s = a.session();
  for (let i = 0; i < 5; i++) {
    a.tapPair(fakePair("en", ex.pairs[0].id), ex);
    a.tapPair(fakePair("tgt", ex.pairs[1].id), ex);
  }
  assert.strictEqual(s.hearts, 0);
  assert.strictEqual(s.state, "dead", "the lesson ends where the hearts run out");
  /* Nothing was finished, so there is no score to report. */
  assert.strictEqual(a.answerBox.app.innerHTML.indexOf("0 of 0"), -1,
    "the end screen should not offer a score of nothing");
});

test("in a match the word itself plays, and only the half being learnt", function () {
  const a = loadApp({ voices: [NEURAL_FR] });
  const ex = openMatch(a);
  a.addClips(a.course().items.map(function (it) { return it.id; }));
  const first = ex.pairs[0].id, second = ex.pairs[1].id;
  a.played.length = 0;

  a.tapPair(fakePair("tgt", first), ex);
  eq(a.clipsPlayed(), ["assets/audio/fr/" + first + ".mp3"], "a tap reads the word out");
  a.tapPair(fakePair("en", first), ex);
  eq(a.session().matched, [first], "the pair landed");
  assert.strictEqual(a.clipsPlayed().length, 1, "closing the link adds nothing");

  /* The other way round: the French half is now the tap that closes the link,
     and it still reads itself out — a tap on the word is what plays it. The
     English half is silent either way, where it used to repeat the French. */
  a.tapPair(fakePair("en", second), ex);
  assert.strictEqual(a.clipsPlayed().length, 1, "the English half is silent");
  a.tapPair(fakePair("tgt", second), ex);
  eq(a.clipsPlayed(), ["assets/audio/fr/" + first + ".mp3", "assets/audio/fr/" + second + ".mp3"]);
});

test("a match carries no speaker buttons of its own", function () {
  const a = loadApp({ voices: [NEURAL_FR] });
  openMatch(a);
  const html = a.answerBox.app.innerHTML;
  assert.strictEqual(html.indexOf("data-item="), -1,
    "the word is the button here; a speaker belongs to the exercises about one word");
  assert.ok(html.indexOf('data-side="tgt"') > -1, "the pairs are still there");
});

test("spaced review pays less and leaves crowns alone", function () {
  const a = loadApp();
  freshSrs(a);
  const lesson = a.course().lessons[0];
  playLesson(a);
  const crowns = a.crownsOf(lesson.id);
  const xp = a.prog().xp;

  /* Make everything ripe, so the review has something to ask. */
  Object.keys(a.prog().srs).forEach(function (id) { a.prog().srs[id].due = Date.now() - 1000; });
  a.startPractice();
  assert.ok(a.session(), "a review session should have started");
  assert.strictEqual(a.session().mode, "practice");
  assert.strictEqual(a.session().hearts, Infinity, "review does not cost hearts");

  let guard = 0;
  while (a.session().state !== "done") {
    if (guard++ > 200) throw new Error("the review never ended");
    answerCurrent(a, true);
    a.advance();
  }
  assert.strictEqual(a.session().gained, 8);
  assert.strictEqual(a.prog().xp, xp + 8);
  assert.strictEqual(a.crownsOf(lesson.id), crowns, "review earns no crown");
});

/* ---------- colour ----------
   The page promises AA contrast in both themes, and the dark palette is
   written out twice — once for the system setting, once for data-theme. Both
   are things a person cannot see going wrong until someone cannot read it. */

function themeTokens() {
  const css = fs.readFileSync(PAGE, "utf8");
  const grab = function (opener) {
    const i = css.indexOf(opener);
    assert.ok(i > -1, "no token block for " + opener);
    const body = css.slice(i + opener.length, css.indexOf("}", i));
    const out = {};
    let m;
    const re = /--([a-z-]+)\s*:\s*(#[0-9A-Fa-f]{6})/g;
    while ((m = re.exec(body))) out[m[1]] = m[2].toUpperCase();
    return out;
  };
  return {
    light: grab(":root{"),
    system: grab('@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){'),
    forced: grab(':root[data-theme="dark"]{')
  };
}

function contrast(a, b) {
  const chan = function (c) {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const lum = function (hex) {
    const n = parseInt(hex.slice(1), 16);
    return 0.2126 * chan((n >> 16) & 255) + 0.7152 * chan((n >> 8) & 255) + 0.0722 * chan(n & 255);
  };
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/* Written out rather than read off the stylesheet: this is the list of places
   text sits on a colour, and a test that derived it would drift with it. */
const ON = [
  ["color-text", "color-background"], ["color-text", "color-surface"],
  ["color-text", "color-surface-soft"], ["color-text", "color-raise"],
  ["color-text", "hero-from"], ["color-text", "hero-to"],
  ["color-text", "color-primary-soft"],
  ["color-text-muted", "color-background"], ["color-text-muted", "color-surface"],
  ["color-text-muted", "color-raise"], ["color-text-muted", "hero-from"],
  ["color-primary-ink", "color-surface"], ["color-primary-ink", "color-background"],
  ["color-primary-ink", "color-primary-soft"], ["color-primary-ink", "tile-mint"],
  ["color-primary-ink", "hero-from"], ["color-primary-ink", "hero-to"],
  ["color-accent-ink", "color-surface"], ["color-accent-ink", "tile-gold"],
  ["color-coral-ink", "color-surface"], ["color-coral-ink", "tile-coral"],
  ["color-cta-ink", "color-cta"], ["medal-ink", "medal-to"]
];

test("every pair of text and background clears AA, in both themes", function () {
  const themes = themeTokens();
  [["light", themes.light], ["dark", themes.forced]].forEach(function (pair) {
    const name = pair[0], t = pair[1];
    ON.forEach(function (on) {
      const ink = t[on[0]] || themes.light[on[0]];
      const bg = t[on[1]] || themes.light[on[1]];
      assert.ok(ink && bg, name + ": no value for " + on[0] + " or " + on[1]);
      const r = contrast(ink, bg);
      assert.ok(r >= 4.5, name + ": " + on[0] + " on " + on[1]
        + " is " + r.toFixed(2) + ":1, under the 4.5 AA asks for");
    });
    /* A filled primary button is white on the brand green in both themes. */
    const onGreen = contrast("#FFFFFF", t["color-primary"] || themes.light["color-primary"]);
    assert.ok(onGreen >= 4.5, name + ": white on the primary is " + onGreen.toFixed(2) + ":1");
  });
});

test("the dark palette is one palette, not two that drifted", function () {
  const themes = themeTokens();
  eq(themes.forced, themes.system,
     "the system block and the data-theme block must hold the same colours");
});

test("dark is not the light theme with the lights off", function () {
  const themes = themeTokens();
  const warmer = function (hex) {
    const n = parseInt(hex.slice(1), 16);
    return ((n >> 16) & 255) - (n & 255);   /* red over blue: how warm it reads */
  };
  ["color-background", "color-surface", "color-text"].forEach(function (k) {
    assert.ok(warmer(themes.forced[k]) > 0,
      k + " is " + themes.forced[k] + ", which is not a warm colour");
  });
  assert.notStrictEqual(themes.forced["color-cta"], themes.light["color-cta"],
    "the dark call to action should not be the light one");
});

/* ---------- the three practice sets ---------- */

test("the mistakes set holds only what was missed, the worst of it first", function () {
  const a = loadApp();
  freshSrs(a, "fr");
  const c = a.course();
  const missed = c.items[0], worse = c.items[1], clean = c.items[2];
  a.gradeItem(missed.id, false);
  a.gradeItem(worse.id, false);
  a.gradeItem(worse.id, false);
  a.gradeItem(clean.id, true);

  eq(a.practiceItems("mistakes", c).map(function (it) { return it.id; }),
     [worse.id, missed.id], "two missed words, the worse one first");
});

test("the listening drill asks only by ear, and only what has been met", function () {
  const a = loadApp({ voices: [NEURAL_FR] });
  freshSrs(a, "fr");
  const c = a.course();
  const met = c.items.slice(0, 12);
  met.forEach(function (it) { a.gradeItem(it.id, true); });

  const q = a.buildPractice(c, "listen");
  assert.strictEqual(q.length, 10, "ten at a time, out of the twelve met");
  const seen = {};
  met.forEach(function (it) { seen[it.id] = true; });
  q.forEach(function (ex) {
    assert.strictEqual(ex.kind, "listen", "the drill fixes the shape of the question");
    assert.ok(seen[ex.item.id], "a drill is no place to meet a word for the first time");
  });
});

test("with no voice and no recording there is nothing to listen to", function () {
  const a = loadApp();
  freshSrs(a, "fr");
  const c = a.course();
  c.items.slice(0, 5).forEach(function (it) { a.gradeItem(it.id, true); });
  eq(a.practiceItems("listen", c), [], "nothing can be played");
  eq(a.buildPractice(c, "listen"), [], "so no session is built");
});

test("a practice set starts a session made of its own words", function () {
  const a = loadApp({ voices: [NEURAL_FR] });
  freshSrs(a, "fr");
  const c = a.course();
  const missed = c.items.slice(0, 14);
  missed.forEach(function (it) { a.gradeItem(it.id, false); });

  a.startPractice("mistakes");
  const s = a.session();
  assert.strictEqual(s.mode, "practice");
  assert.strictEqual(s.set, "mistakes");
  assert.strictEqual(s.hearts, Infinity, "practice never costs a heart");
  assert.strictEqual(s.queue.length, 10);
  const inSet = {};
  missed.forEach(function (it) { inSet[it.id] = true; });
  s.queue.forEach(function (ex) {
    assert.ok(inSet[ex.item.id], ex.item.tgt + " was never missed");
  });
});

test("a Review button that hands over its click still runs today's review", function () {
  const a = loadApp({ voices: [NEURAL_FR] });
  freshSrs(a, "fr");
  a.course().items.slice(0, 6).forEach(function (it) { a.gradeItem(it.id, true); });
  Object.keys(a.prog().srs).forEach(function (id) { a.prog().srs[id].due = Date.now() - 1000; });

  /* The older buttons pass the event straight through as the first argument. */
  a.startPractice({ type: "click" });
  assert.strictEqual(a.session().set, "due", "an event is not a set name");
});

test("the progress page is headed by Leon climbing", function () {
  const a = loadApp();
  freshSrs(a, "fr");
  const html = a.pageProgress();
  assert.ok(html.indexOf('src="assets/leon-progress.webp"') > -1, "the animation should be there");
  assert.ok(html.indexOf('alt="Leon') > -1, "and it should say who it is");
});

test("the practice page is headed by Leon at his desk", function () {
  const a = loadApp({ voices: [NEURAL_FR] });
  freshSrs(a, "fr");
  const html = a.pagePractice();
  assert.ok(html.indexOf('src="assets/leon-practice.webp"') > -1, "the animation should be there");
  assert.ok(html.indexOf('alt="Leon') > -1, "and it should say who it is");
});

test("the practice page counts each set and offers only what it can run", function () {
  const a = loadApp({ voices: [NEURAL_FR] });
  freshSrs(a, "fr");
  let html = a.pagePractice();
  assert.ok(html.indexOf('data-practice="listen" disabled') > -1, "nothing met yet");
  assert.ok(html.indexOf('data-practice="mistakes" disabled') > -1, "nothing missed yet");
  assert.strictEqual(html.indexOf('data-practice="due"'), -1, "and nothing to review");

  const c = a.course();
  c.items.slice(0, 3).forEach(function (it) { a.gradeItem(it.id, false); });
  Object.keys(a.prog().srs).forEach(function (id) { a.prog().srs[id].due = Date.now() - 1000; });
  html = a.pagePractice();
  assert.ok(html.indexOf("3 words are waiting") > -1, "the review says how many are ripe");
  assert.ok(html.indexOf('data-practice="mistakes"') > -1
    && html.indexOf('data-practice="mistakes" disabled') === -1, "the mistakes set is ready");
  assert.ok(html.indexOf('data-practice="listen"') > -1
    && html.indexOf('data-practice="listen" disabled') === -1, "and so is the drill");
});

test("Leon lifts the trophy once there is one to lift", function () {
  const a = loadApp();
  freshSrs(a, "fr");
  const quiet = a.pageAchievements();
  assert.strictEqual(a.achEarned().length, 0, "nothing unlocked on a fresh course");
  assert.strictEqual(quiet.indexOf("leon-trophy.webp"), -1,
    "no trophy before one has been won");

  playLesson(a);
  assert.ok(a.achEarned().length > 0, "a first lesson unlocks something");
  const won = a.pageAchievements();
  assert.ok(won.indexOf('src="assets/leon-trophy.webp"') > -1, "the animation should be there");
  assert.ok(won.indexOf("alt=\"Leon") > -1, "and it should say who it is");
});

test("progress is kept per course", function () {
  const a = loadApp();
  freshSrs(a, "es");
  playLesson(a);
  const spanish = a.prog().xp;
  assert.ok(spanish > 0);
  a.setActive("la");
  assert.strictEqual(a.prog().xp, 0, "Latin starts untouched");
  eq(a.prog().srs, {});
  a.setActive("es");
  assert.strictEqual(a.prog().xp, spanish, "and Spanish is still where it was");
});

/* ---------- the streak ---------- */

test("the streak counts consecutive days and resets after a gap", function () {
  const a = loadApp();
  const S = a.state();

  S.streak = 0; S.lastDay = null;
  a.touchStreak();
  assert.strictEqual(S.streak, 1, "the first day ever");

  a.touchStreak();
  assert.strictEqual(S.streak, 1, "twice in one day is still one day");

  S.lastDay = yesterday();
  a.touchStreak();
  assert.strictEqual(S.streak, 2, "a day later it climbs");

  S.lastDay = daysAgo(3);
  a.touchStreak();
  assert.strictEqual(S.streak, 1, "a missed day starts over");
});

test("dayDiff reads calendar days, not hours", function () {
  const a = loadApp();
  assert.strictEqual(a.dayDiff("2026-11-14", "2026-11-15"), 1);
  assert.strictEqual(a.dayDiff("2026-11-15", "2026-11-15"), 0);
  assert.strictEqual(a.dayDiff("2026-02-28", "2026-03-01"), 1, "2026 is not a leap year");
  assert.strictEqual(a.dayDiff(null, "2026-11-15"), null);
});

function stamp(d) {
  return d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0");
}
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return stamp(d);
}
function yesterday() { return daysAgo(1); }

/* ---------- course content ---------- */

test("every course carries the same shape", function () {
  const a = loadApp();
  eq(a.LANGS, ["es", "fr", "de", "it", "la", "ru", "en"]);
  a.LANGS.forEach(function (lg) {
    const c = a.COURSES[lg];
    assert.strictEqual(c.units.length, 7, lg + " should have seven units");
    assert.strictEqual(c.lessons.length, 14, lg + " should have fourteen lessons");
    assert.strictEqual(c.items.length, 112, lg + " should have 112 items");
    c.lessons.forEach(function (l) {
      assert.ok(l.kind === "w" || l.kind === "p", "a lesson is words or phrases");
      /* Units alternate: ten words, then six phrases built from them. */
      assert.strictEqual(l.items.length, l.kind === "w" ? 10 : 6,
        lg + "/" + l.id + " has the wrong number of items");
      l.items.forEach(function (it) {
        assert.strictEqual(it.kind, l.kind, lg + "/" + it.id + " does not match its lesson");
      });
    });
    const vocab = c.lessons.filter(function (l) { return l.kind === "w"; });
    assert.strictEqual(vocab.length, 7, lg + " should have one vocabulary lesson per unit");
    vocab.forEach(function (l) {
      assert.ok(l.items.length >= 5, lg + "/" + l.id + " cannot fill a five-pair match");
    });
  });
});

test("no item is blank and no id repeats", function () {
  const a = loadApp();
  const seen = new Set();
  a.LANGS.forEach(function (lg) {
    a.COURSES[lg].items.forEach(function (it) {
      assert.ok(it.en && it.en.trim(), lg + ": an item has no English side");
      assert.ok(it.tgt && it.tgt.trim(), lg + ": " + it.en + " has no translation");
      assert.ok(!seen.has(it.id), "duplicate item id " + it.id);
      seen.add(it.id);
    });
  });
});

test("a declared word bank spells out its own phrase", function () {
  const a = loadApp();
  a.LANGS.forEach(function (lg) {
    a.COURSES[lg].items.forEach(function (it) {
      if (!it.bank) return;
      assert.strictEqual(a.loose(it.bank.join(" ")), a.loose(it.tgt),
        lg + ": the bank for \"" + it.en + "\" does not build \"" + it.tgt + "\"");
    });
  });
});

/* ---------- report ---------- */

const failed = results.filter(function (r) { return !r.ok; });
results.forEach(function (r) {
  console.log((r.ok ? "  ok   " : "  FAIL ") + r.name);
  if (!r.ok) console.log("         " + (r.err && r.err.message || r.err));
});
console.log("");
console.log(results.length - failed.length + " passed, " + failed.length + " failed");
if (failed.length) {
  failed.forEach(function (r) { if (r.err && r.err.stack) console.log("\n" + r.err.stack); });
  process.exit(1);
}
