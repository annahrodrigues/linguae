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
  scoreSpeech: scoreSpeech, sameWord: sameWord, startMic: startMic, micSays: micSays,
  canListen: canListen, bodyFor: bodyFor, footFor: footFor,
  AUDIO: AUDIO, clipFor: clipFor, sayItem: sayItem, canHear: canHear, FLAGS: FLAGS,
  clipForWord: clipForWord, sayWord: sayWord, wordKey: wordKey,
  useTile: useTile, dropTile: dropTile, tileFree: tileFree, bankHits: bankHits,
  typeTile: typeTile, settleTile: settleTile, rubOut: rubOut, typedChar: typedChar,
  courseHasAudio: courseHasAudio,
  pageAchievements: pageAchievements, pageProgress: pageProgress, achEarned: achEarned,
  pageLearn: pageLearn, UNIT_META: UNIT_META,
  studiedToday: studiedToday, flame: flame, shell: shell,
  settleStreak: settleStreak, freezesHeld: freezesHeld, dayBefore: dayBefore,
  freezeRow: freezeRow, thawNote: thawNote, pageLearn2: pageLearn,
  mergeState: mergeState, mergeCourse: mergeCourse, mergeSrs: mergeSrs,
  tidyCode: tidyCode, newCode: newCode, syncNow: syncNow, syncCard: syncCard,
  syncSays: syncSays, syncWhen: syncWhen, syncOn: syncOn, viewPicker: viewPicker,
  syncState: function(){ return sync; },
  setSync: function(o){ Object.assign(sync, o); saveSync(); },
  setState: function(x){ S = x; },
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
    /* opts.stored is what the browser already had, so a test can see what the
       app does to it on the way up rather than only afterwards. */
    localStorage: (function () {
      const store = makeStorage();
      if (opts.stored) store.setItem("lingua-trail-v1", JSON.stringify(opts.stored));
      return store;
    })(),
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
  /* opts.hears stands in for the recogniser: an array of alternatives it will
     hand back, or a string naming the error it fails with. Absent altogether
     stands in for a browser that cannot listen, Firefox among them. */
  const recordings = [];
  if (opts.hears !== undefined) {
    win.SpeechRecognition = function () {
      return {
        lang: "", continuous: true, interimResults: true, maxAlternatives: 1,
        onresult: null, onerror: null, onend: null,
        abort() {}, stop() {},
        start() {
          recordings.push({ lang: this.lang, alternatives: this.maxAlternatives,
                            interim: this.interimResults });
          if (typeof opts.hears === "string") {
            if (this.onerror) this.onerror({ error: opts.hears });
          } else if (this.onresult) {
            this.onresult({
              results: [opts.hears.map(function (t) {
                return { transcript: t, confidence: 0.9 };
              })]
            });
          }
          if (this.onend) this.onend();
        }
      };
    };
  }
  /* opts.manifest stands in for assets/audio/index.json arriving over the
     network, which is the only thing that switches the recordings on. */
  if (opts.manifest && !opts.server) {
    sandbox.fetch = function (url) {
      if (String(url).indexOf("assets/audio/index.json") === -1) {
        return Promise.resolve({ ok: false, status: 404 });
      }
      return Promise.resolve({
        ok: true, status: 200,
        json: function () { return Promise.resolve(opts.manifest); }
      });
    };
  }
  /* opts.server stands in for the sync worker: one object per code, and a log
     of everything that was asked of it. The app is handed a fetch only when a
     test asks for one, because without it the app does not sync at all. */
  const server = opts.server;
  if (server) {
    server.slots = server.slots || {};
    server.calls = server.calls || [];
    sandbox.fetch = function (url, init) {
      const method = (init && init.method) || "GET";
      server.calls.push({ url: String(url), method: method, body: init && init.body });
      if (server.down) return Promise.reject(new Error("failed to fetch"));
      const at = server.now || 1700000000000;
      const hit = String(url).match(/\/v1\/([^/?]+)$/);
      const answer = function (status, body) {
        return Promise.resolve({
          ok: status >= 200 && status < 300, status: status,
          json: function () { return Promise.resolve(body); }
        });
      };
      if (!hit) return answer(404, {});                      /* the clip manifest */
      if (server.status) return answer(server.status, { error: "no" });
      const code = hit[1];
      if (method === "PUT") {
        if (server.putStatus) return answer(server.putStatus, { error: "no" });
        server.slots[code] = JSON.parse(init.body).state;
        return answer(200, { at: at });
      }
      if (!Object.prototype.hasOwnProperty.call(server.slots, code)) return answer(404, {});
      return answer(200, { state: server.slots[code], at: at });
    };
  }
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
  api.recordings = recordings;
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
  /* The same, for the clips recorded for the tiles: a map of word to file,
     exactly as the manifest carries it. */
  api.addWordClips = function (lg, map) {
    api.AUDIO.words[lg] = Object.assign({}, api.AUDIO.words[lg] || {}, map);
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

/* The sync client answers through promises, so those tests are collected here
   and run after the rest. The report still prints once, and in order. */
const waiting = [];
function atest(name, fn) {
  if (only && name.indexOf(only) === -1) return;
  waiting.push({ name: name, fn: fn });
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
  assert.strictEqual(items.length, 336);
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

/* ---------- the words on the tiles ---------- */

/* Build the sentence cuts a phrase into pieces, and a piece is almost never an
   item: of the 97 chunks in the French course, 11 are words the course teaches
   on their own. Tapping one used to reach for the system voice, which on most
   machines has nothing to say in French. */
function bankSession(a, tiles) {
  const item = a.course().items.filter(function (x) { return x.kind === "p"; })[0];
  a.startLesson(a.course().lessons[0]);
  const s = a.session();
  s.queue[s.idx] = { id: item.id, item: item, kind: "bank",
                     parts: tiles.slice(), tiles: tiles.slice() };
  s.used = [];
  /* Whatever starting the lesson played is not what this test is about. */
  a.played.length = 0;
  a.spoken.length = 0;
  return s;
}

test("a word's clip is found by the word, not by an id it does not have", function () {
  const a = loadApp({ voices: [NEURAL_FR] });
  a.setActive("fr");
  assert.strictEqual(a.clipForWord("Comment", "fr"), null, "nothing recorded yet");
  a.addWordClips("fr", { "comment": "comment", "ça": "ca", "está": "esta-2" });

  assert.strictEqual(a.clipForWord("Comment", "fr"), "assets/audio/fr/w/comment.mp3",
    "the same word at the front of a sentence is the same recording");
  assert.strictEqual(a.clipForWord("\u00e7a", "fr"), "assets/audio/fr/w/ca.mp3",
    "the file name is ASCII even where the word is not");
  assert.strictEqual(a.clipForWord("est\u00e1", "fr"), "assets/audio/fr/w/esta-2.mp3",
    "and an accent is not flattened away: esta and est\u00e1 are two words");
  assert.strictEqual(a.clipForWord("esta", "fr"), null, "which is why this one is not that one");
  assert.strictEqual(a.clipForWord("comment", "es"), null, "a course only reads its own");
});

test("tapping a tile reads the word, from its own recording", function () {
  const a = loadApp({ voices: [BRAZIL_PT] });   /* no French voice on this machine */
  a.setActive("fr");
  a.addWordClips("fr", { "comment": "comment", "va": "va" });
  bankSession(a, ["Comment", "va"]);

  a.useTile(0);
  eq(a.clipsPlayed(), ["assets/audio/fr/w/comment.mp3"]);
  eq(a.session().used, ["Comment"], "and the word still goes into the sentence");
  assert.strictEqual(a.spoken.length, 0, "the voice is not asked as well");

  /* A tap on a tile that is not there -- a stale click on a redrawn row --
     must not drop an empty word into the sentence. */
  a.useTile(9);
  a.dropTile(9);
  eq(a.session().used, ["Comment"], "nothing was added and nothing was taken");
  assert.strictEqual(a.clipsPlayed().length, 1, "and nothing was read");
});

test("taking a word back out reads it again", function () {
  const a = loadApp({ voices: [BRAZIL_PT] });
  a.setActive("fr");
  a.addWordClips("fr", { "comment": "comment", "va": "va" });
  bankSession(a, ["Comment", "va"]);

  a.useTile(1);
  a.useTile(0);
  eq(a.session().used, ["va", "Comment"]);
  a.dropTile(0);
  eq(a.session().used, ["Comment"], "the word came out");
  eq(a.clipsPlayed(), ["assets/audio/fr/w/va.mp3", "assets/audio/fr/w/comment.mp3",
                       "assets/audio/fr/w/va.mp3"], "and was read on the way");
});

test("a word nobody recorded takes the voice, or nothing at all", function () {
  const withVoice = loadApp({ voices: [NEURAL_FR] });
  withVoice.setActive("fr");
  bankSession(withVoice, ["Comment"]);
  withVoice.useTile(0);
  assert.strictEqual(withVoice.clipsPlayed().length, 0, "there is no clip for it");
  assert.strictEqual(withVoice.spoken.length, 1, "so the voice reads it");
  assert.strictEqual(withVoice.spoken[0].text, "Comment");

  /* And where the machine has no French voice either, silence: French read
     with a Portuguese mouth teaches the wrong thing. */
  const mute = loadApp({ voices: [BRAZIL_PT] });
  mute.setActive("fr");
  bankSession(mute, ["Comment"]);
  mute.useTile(0);
  assert.strictEqual(mute.clipsPlayed().length, 0);
  assert.strictEqual(mute.spoken.length, 0);
  eq(mute.session().used, ["Comment"], "the tile still moves");
});

test("a word clip that will not load falls back to the voice", function () {
  const a = loadApp({ voices: [NEURAL_FR], clipFails: true });
  a.setActive("fr");
  a.addWordClips("fr", { "comment": "comment" });
  bankSession(a, ["Comment"]);

  a.useTile(0);
  assert.strictEqual(a.clipsPlayed().length, 1, "it tries the recording first");
  assert.strictEqual(a.spoken.length, 1, "and the voice picks up when it will not load");
  assert.strictEqual(a.spoken[0].text, "Comment");
});

atest("the manifest is the only thing that switches a recording on", async function () {
  const a = loadApp({ voices: [BRAZIL_PT], manifest: {
    format: "mp3",
    items: ["fr-0-0"],
    words: { fr: { "comment": "comment" } }
  } });
  a.setActive("fr");
  /* Three promises deep: the fetch, the json, and the handler. */
  await new Promise(function (r) { setTimeout(r, 0); });

  assert.strictEqual(a.clipFor(a.course().byId["fr-0-0"]), "assets/audio/fr/fr-0-0.mp3",
    "the item clips came off the manifest");
  assert.strictEqual(a.clipForWord("Comment", "fr"), "assets/audio/fr/w/comment.mp3",
    "and so did the tile words");
});

/* The recordings are named by tools/audio.js and found by the app, and the two
   agree on the word only as long as they agree on what a word is. This reads
   the manifest that was actually written and asks the app for every piece the
   tiles of that course can show. */
test("every piece a tile can show has a recording, in the courses that have any", function () {
  const file = path.join(__dirname, "assets", "audio", "index.json");
  if (!fs.existsSync(file)) return;
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!manifest.words) return;

  const a = loadApp();
  a.AUDIO.format = manifest.format || "mp3";
  Object.keys(manifest.words).forEach(function (lg) {
    a.addWordClips(lg, manifest.words[lg]);
  });

  let checked = 0;
  Object.keys(manifest.words).forEach(function (lg) {
    assert.ok(a.LANGS.indexOf(lg) > -1, lg + " is not a course");
    a.COURSES[lg].items.forEach(function (it) {
      if (it.kind !== "p") return;
      (it.bank ? it.bank : a.words(it.tgt)).forEach(function (w) {
        assert.ok(a.clipForWord(w, lg),
          lg + ': no recording for "' + w + '" (from ' + it.id + ') — rerun'
          + " python tools/kokoro.py " + lg + " --words && node tools/audio.js manifest");
        checked++;
      });
    });
  });
  assert.ok(checked > 300, "only " + checked + " tile words were checked");
});

/* A clip is a file named after an item, and the file does not change when the
   item does. Adding the article to the French nouns left ten recordings saying
   "homme" under a page that had come to say "l'homme", and the only way anyone
   found out was by listening. tools/kokoro.py writes down the line it recorded;
   this reads that back against the course as it stands now. */
test("every recording was made from the words the course has now", function () {
  const file = path.join(__dirname, "assets", "audio", "recorded.json");
  if (!fs.existsSync(file)) return;
  const said = JSON.parse(fs.readFileSync(file, "utf8"));

  const index = path.join(__dirname, "assets", "audio", "index.json");
  if (!fs.existsSync(index)) return;
  const manifest = JSON.parse(fs.readFileSync(index, "utf8"));

  /* Every clip the manifest switches on, rather than every clip the ledger
     happens to mention: a recording nobody can vouch for is the thing being
     looked for, so an id missing from the ledger has to fail here and not be
     passed over. */
  const a = loadApp();
  let checked = 0;
  (manifest.items || []).forEach(function (id) {
    const lg = id.slice(0, id.indexOf("-"));
    assert.ok(a.LANGS.indexOf(lg) > -1, lg + " is not a course");
    const item = a.COURSES[lg].byId[id];
    assert.ok(item, id + " has a clip and no item to go with it");
    const heard = said[lg] && said[lg][id];
    assert.ok(heard !== undefined,
      id + " has a clip that nothing says the words of \u2014 rerun"
      + " python tools/kokoro.py " + lg + " --audit");
    assert.strictEqual(heard, item.tgt,
      lg + "/" + id + ' was recorded saying "' + heard + '" and the course now says "'
      + item.tgt + '" \u2014 rerun python tools/kokoro.py ' + lg);
    checked++;
  });
  assert.ok(checked > 800, "only " + checked + " recordings were checked");
});

test("the tile recordings were made from the words the tiles show", function () {
  const file = path.join(__dirname, "assets", "audio", "recorded.json");
  const index = path.join(__dirname, "assets", "audio", "index.json");
  if (!fs.existsSync(file) || !fs.existsSync(index)) return;
  const said = JSON.parse(fs.readFileSync(file, "utf8"));
  const manifest = JSON.parse(fs.readFileSync(index, "utf8"));
  if (!manifest.words) return;

  let checked = 0;
  Object.keys(manifest.words).forEach(function (lg) {
    Object.keys(manifest.words[lg]).forEach(function (word) {
      const slug = manifest.words[lg][word];
      const heard = said[lg] && said[lg]["w/" + slug];
      assert.ok(heard !== undefined,
        lg + "/w/" + slug + " has a clip that nothing says the words of");
      /* The manifest keys a word by its lower case; the recording was made
         from the piece as the tile prints it. */
      assert.strictEqual(heard.toLowerCase(), word,
        lg + ': the clip for "' + word + '" was made saying "' + heard + '"');
      checked++;
    });
  });
  assert.ok(checked > 500, "only " + checked + " tile recordings were checked");
});

test("the page credits the voice it was lent", function () {
  const a = loadApp();
  a.setActive("de");
  a.prog().srs = {}; a.prog().crowns = {};
  /* The German and Russian recordings were made on ElevenLabs' free plan,
     which asks that the work credit it. Written out rather than read from the
     page: a test that quotes the line it is checking agrees with any line. */
  const html = a.shell();
  assert.ok(html.indexOf("elevenlabs.io") > -1, "the credit should be on the page");
  assert.ok(html.indexOf("German and Russian") > -1, "and say what it is for");
  /* Tatoeba's CC BY 2.0 FR asks for the mention, the link and the licence
     name, which is three things and not one. */
  /* Tatoeba asks for three things: that the work say so, that it link back,
     and that it name the licence. A mention without the link is two of them. */
  assert.ok(html.indexOf('href="https://tatoeba.org"') > -1,
    "the sentences are owed a link, not just a mention");
  assert.ok(html.indexOf("CC BY 2.0 FR") > -1, "with the licence named");
});

test("a clip's name does not move when its neighbours do", function () {
  const file = path.join(__dirname, "assets", "audio", "index.json");
  if (!fs.existsSync(file)) return;
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!manifest.words) return;

  /* A Cyrillic word leaves nothing behind when it is reduced to ASCII, so its
     file used to be named after its place in the sorted list. Adding one word
     to the course then renamed every file after it, and every clip had to be
     recorded again for nothing. A name taken from the word itself stays put. */
  let checked = 0;
  Object.keys(manifest.words).forEach(function (lg) {
    /* The old scheme named a word after where it fell in the sorted list, so
       what has to be ruled out is a name that *is* that number. A digest can
       come out all digits by chance -- one of these does -- so the test is
       against the index itself and not against the shape of the name. */
    const order = Object.keys(manifest.words[lg]).sort();
    order.forEach(function (word, i) {
      assert.notStrictEqual(manifest.words[lg][word], "w" + i,
        lg + ': "' + word + '" is filed under its place in the list');
      checked++;
    });
  });
  assert.ok(checked > 900, "only " + checked + " names were checked");
});

test("a tile's file name comes from the word, not from its neighbours", function () {
  const { slugs } = require("./tools/audio.js");
  /* Nothing of a Cyrillic word survives the trip to ASCII, so its file used to
     be named after where it fell in the sorted list. Adding one word then
     renamed every file after it and every clip was recorded again for nothing
     -- and the evidence disappeared with the names, which is why this asks the
     naming directly instead of reading a manifest. */
  const word = "\u0434\u0435\u0432\u043e\u0447\u043a\u0430";
  const alone = slugs([word, "zebra"]);
  const crowded = slugs([word, "zebra", "\u0430", "\u0431", "\u0432", "\u0433", "apple"]);
  assert.strictEqual(alone[word], crowded[word],
    "the same word in a longer list should keep its name");
  assert.ok(alone[word], "and it should have one at all");

  /* Two different words still have to land on two different names. */
  const two = slugs(["\u0447\u0430\u0441", "\u0447\u0430\u0441\u044b"]);
  assert.notStrictEqual(two["\u0447\u0430\u0441"], two["\u0447\u0430\u0441\u044b"]);
});

test("no clip is named after a device Windows keeps for itself", function () {
  const file = path.join(__dirname, "assets", "audio", "index.json");
  if (!fs.existsSync(file)) return;
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!manifest.words) return;
  /* CON, PRN, AUX, NUL and the COM and LPT ports are device names there.
     Writing con.mp3 opens the device, reports success and leaves nothing on
     disk, so the Spanish word for "with" had no recording and nothing said
     so. Written out rather than read from the tool that builds the names. */
  const device = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
  let checked = 0;
  Object.keys(manifest.words).forEach(function (lg) {
    Object.keys(manifest.words[lg]).forEach(function (word) {
      const name = manifest.words[lg][word];
      assert.ok(!device.test(name),
        lg + '/' + name + '.mp3 cannot exist on Windows (the word is "' + word + '")');
      checked++;
    });
  });
  assert.ok(checked > 300, "only " + checked + " names were checked");
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
  ["color-text-muted", "tile-gold"],
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

/* ---------- typing the sentence instead of tapping it ---------- */

/* The pieces are planted: what is being checked is how the letters find them,
   and no course owes this test a sentence of the right shape. */
function bankSession(a, tiles) {
  a.startLesson(a.course().lessons[0]);
  const s = a.session();
  const item = a.course().items[0];
  s.queue[s.idx] = { id: item.id, item: item, kind: "bank",
                     parts: tiles.slice(), tiles: tiles };
  s.state = "ask";
  s.used = [];
  s.typed = "";
  return s;
}

function typeWord(a, text) {
  String(text).split("").forEach(function (ch) { a.typeTile(ch); });
}

test("a word only one piece begins with is laid down as it is typed", function () {
  const a = loadApp();
  freshSrs(a, "fr");
  const s = bankSession(a, ["Comment", "t'appelles", "le", "jours", "tu"]);

  a.typeTile("t");
  eq(s.used, [], "t could still be t'appelles or tu");
  assert.strictEqual(s.typed, "t", "so the letters wait on screen");

  a.typeTile("u");
  eq(s.used, ["tu"], "and tu can be nothing else");
  assert.strictEqual(s.typed, "", "the letters are spent");
});

test("a letter no piece begins with is dropped where it falls", function () {
  const a = loadApp();
  freshSrs(a, "fr");
  const s = bankSession(a, ["Comment", "t'appelles", "tu"]);
  a.typeTile("t");
  assert.strictEqual(a.typeTile("z"), false, "nothing begins tz");
  assert.strictEqual(s.typed, "t", "and the letters typed so far are untouched");
  eq(s.used, [], "a slip costs the keystroke, not the sentence");
  a.typeTile("u");
  eq(s.used, ["tu"], "and typing carries on from where it was");
});

test("where a longer piece begins the same way, a space settles it", function () {
  const a = loadApp();
  freshSrs(a, "fr");
  const s = bankSession(a, ["le", "les", "chat"]);
  typeWord(a, "le");
  eq(s.used, [], "le is also the start of les");
  assert.strictEqual(s.typed, "le");

  assert.strictEqual(a.settleTile(), true);
  eq(s.used, ["le"], "the space settles for the word as typed");
  assert.strictEqual(s.typed, "");

  typeWord(a, "les");
  eq(s.used, ["le", "les"], "and the longer one still types out in full");
});

test("a space settles nothing where nothing is typed out whole", function () {
  const a = loadApp();
  freshSrs(a, "fr");
  const s = bankSession(a, ["Comment", "comme", "tu"]);
  a.typeTile("c");
  assert.strictEqual(a.settleTile(), false, "c alone is not a word on the table");
  eq(s.used, []);
  assert.strictEqual(s.typed, "c", "and the letters are still waiting");
});

test("the same word printed twice is still one word", function () {
  const a = loadApp();
  freshSrs(a, "fr");
  const s = bankSession(a, ["le", "le", "chat"]);
  typeWord(a, "le");
  eq(s.used, ["le"], "either piece will do, so it goes down at once");

  typeWord(a, "le");
  eq(s.used, ["le", "le"], "and the second piece after it");

  assert.strictEqual(a.typeTile("l"), false, "with both spent, nothing begins with l");
});

test("accents and apostrophes are never in the way", function () {
  const a = loadApp();
  freshSrs(a, "fr");
  const s = bankSession(a, ["\u00e7a", "comment", "va"]);
  typeWord(a, "ca");
  eq(s.used, ["\u00e7a"], "ca finds \u00e7a, which is what a keyboard has to hand");
});

test("a key with the accent already on it finds the word too", function () {
  const a = loadApp();
  freshSrs(a, "fr");
  const s = bankSession(a, ["\u00e7a", "va", "bien"]);
  /* The other half of the same rule: both sides of the comparison are
     loosened, not only the word printed on the piece. */
  typeWord(a, "\u00e7");
  eq(s.used, ["\u00e7a"]);
});

test("an apostrophe typed inside a word is a letter like any other", function () {
  const a = loadApp();
  freshSrs(a, "fr");
  const s = bankSession(a, ["t'appelles", "tu", "comment"]);
  a.typeTile("t");
  assert.strictEqual(s.typed, "t", "t could still be either");
  assert.strictEqual(a.typeTile("'"), true, "the apostrophe is taken");
  assert.strictEqual(s.typed, "t'");
  a.typeTile("a");
  eq(s.used, ["t'appelles"], "and it was never in the way of the match");
});

test("a keystroke that leaves nothing to compare lays nothing down", function () {
  const a = loadApp();
  freshSrs(a, "fr");
  const s = bankSession(a, ["bonjour"]);
  /* An empty prefix is the start of every word on the table, so without this
     an apostrophe would lay down the last piece left. */
  assert.strictEqual(a.typeTile("'"), false);
  eq(s.used, []);
  assert.strictEqual(s.typed, "");
});

test("backspace takes the letters back first, then the last piece", function () {
  const a = loadApp();
  freshSrs(a, "fr");
  const s = bankSession(a, ["Comment", "comme", "t'appelles", "tu"]);
  typeWord(a, "tu");
  eq(s.used, ["tu"]);

  /* c could still be Comment or comme, so it waits on screen as a letter. */
  a.typeTile("c");
  assert.strictEqual(s.typed, "c");
  assert.strictEqual(a.rubOut(), true);
  assert.strictEqual(s.typed, "", "the letter goes first");
  eq(s.used, ["tu"], "and the piece is still down");

  assert.strictEqual(a.rubOut(), true);
  eq(s.used, [], "the next one takes the piece back up");
  assert.strictEqual(a.rubOut(), false, "and there is nothing left to take back");
});

test("tapping a piece clears what was half typed", function () {
  const a = loadApp();
  freshSrs(a, "fr");
  const s = bankSession(a, ["Comment", "t'appelles", "tu"]);
  a.typeTile("t");
  assert.strictEqual(s.typed, "t");
  a.useTile(0);
  eq(s.used, ["Comment"]);
  assert.strictEqual(s.typed, "", "the letters went with the tap");
});

test("typing belongs to the word bank and nowhere else", function () {
  const a = loadApp();
  freshSrs(a, "fr");
  const item = a.course().items[0];
  a.startLesson(a.course().lessons[0]);
  const s = a.session();
  s.queue[s.idx] = { id: item.id, item: item, kind: "write" };
  s.state = "ask";
  assert.strictEqual(a.typeTile("t"), false, "a typed answer has its own box");
  assert.strictEqual(a.rubOut(), false);

  const bank = bankSession(a, ["tu"]);
  bank.state = "feedback";
  assert.strictEqual(a.typeTile("t"), false, "and a question already answered takes nothing");
});

test("the half-typed letters and the pieces they could still mean are shown", function () {
  const a = loadApp();
  freshSrs(a, "fr");
  const s = bankSession(a, ["le", "les", "chat"]);
  a.typeTile("l");

  const html = a.bodyFor(s.queue[s.idx], false);
  assert.ok(html.indexOf('<span class="typed">l</span>') > -1, "the letters sit in the sentence");
  assert.strictEqual(html.split('tile-w hot').length - 1, 2, "both le and les are lit up");

  const locked = a.bodyFor(s.queue[s.idx], true);
  assert.strictEqual(locked.indexOf('class="typed"'), -1,
    "once the answer is checked there is nothing left to type");
  assert.strictEqual(locked.indexOf("hot"), -1);
});

test("a piece already in the sentence is not offered to the letters again", function () {
  const a = loadApp();
  freshSrs(a, "fr");
  const s = bankSession(a, ["Comment", "tu"]);
  typeWord(a, "tu");
  eq(a.bankHits(s.queue[s.idx], "t"), [], "tu is down, and Comment does not begin with t");
  assert.strictEqual(a.tileFree(s.queue[s.idx], 1), false);
  assert.strictEqual(a.tileFree(s.queue[s.idx], 0), true);
});

test("only a letter, a digit or an apostrophe is typed into the sentence", function () {
  const a = loadApp();
  assert.strictEqual(a.typedChar({ key: "t" }), "t");
  assert.strictEqual(a.typedChar({ key: "'" }), "'");
  assert.strictEqual(a.typedChar({ key: "\u00e7" }), "\u00e7", "an accented key is a letter");
  assert.strictEqual(a.typedChar({ key: "3" }), "3");
  assert.strictEqual(a.typedChar({ key: "Shift" }), "", "a key with a name is not a letter");
  assert.strictEqual(a.typedChar({ key: " " }), "", "a space settles, it does not type");
  assert.strictEqual(a.typedChar({ key: "r", ctrlKey: true }), "",
    "and anything held with Ctrl belongs to the browser");
});

test("the word bank says that it can be typed", function () {
  const a = loadApp();
  freshSrs(a, "fr");
  const s = bankSession(a, ["tu"]);
  assert.ok(a.footFor(s.queue[s.idx]).indexOf("Type a word") > -1);
});

/* ---------- saying it out loud ---------- */

function wordCount(s) { return String(s).split(/\s+/).length; }
function firstWord(s) { return String(s).split(/\s+/)[0]; }

/* The recogniser hands back a sentence, never a mark, so everything the
   pronunciation exercise knows comes out of this one function. */
test("a word said as written comes through whole", function () {
  const a = loadApp();
  const r = a.scoreSpeech("bonjour", ["bonjour"]);
  assert.strictEqual(r.score, 1);
  eq(r.marks, [{ word: "bonjour", ok: true }]);
  assert.strictEqual(r.heard, "bonjour", "and what was heard is kept to show");
});

test("the marking looks past case, accents and punctuation", function () {
  const a = loadApp();
  assert.strictEqual(a.scoreSpeech("Tr\u00e8s bien", ["tres bien."]).score, 1);
  assert.strictEqual(a.scoreSpeech("merci", ["Merci!"]).score, 1);
});

test("a phrase the recogniser splits differently still counts", function () {
  const a = loadApp();
  /* French runs its words together, and the transcript does not always agree
     about where they end; taken whole, the sounds are the same. */
  assert.strictEqual(a.scoreSpeech("l'eau", ["l eau"]).score, 1, "the elision");
  assert.strictEqual(a.scoreSpeech("qu'est-ce que c'est", ["qu est ce que c est"]).score, 1);
});

test("a phrase half heard is marked word by word", function () {
  const a = loadApp();
  const r = a.scoreSpeech("je voudrais un cafe", ["je voudrais un the"]);
  assert.strictEqual(r.of, 4);
  assert.strictEqual(r.got, 3);
  eq(r.marks.map(function (m) { return m.ok; }), [true, true, true, false],
     "the word that did not come through is the one marked");
});

test("a word said once does not answer for a word said twice", function () {
  const a = loadApp();
  /* Every word of the phrase needs its own hearing. Without that, a transcript
     holding the word at all would mark the whole phrase said. */
  const r = a.scoreSpeech("merci merci", ["merci"]);
  assert.strictEqual(r.got, 1);
  assert.strictEqual(r.of, 2);
});

test("nothing heard is nothing said", function () {
  const a = loadApp();
  const r = a.scoreSpeech("bonjour", []);
  assert.strictEqual(r.score, 0);
  eq(r.marks, [{ word: "bonjour", ok: false }]);
  assert.strictEqual(r.heard, "");
});

test("the recogniser's other guesses count too", function () {
  const a = loadApp();
  /* Five alternatives are five hearings of the same breath. Reading only the
     first fails a good answer over the engine's own second thoughts. */
  assert.strictEqual(a.scoreSpeech("au revoir", ["oh revoir", "au revoir"]).score, 1);
});

test("a letter out is the transcript's spelling, unless the word is too short to spare one", function () {
  const a = loadApp();
  assert.strictEqual(a.scoreSpeech("bonjour", ["bonjours"]).score, 1, "one letter on a long word");
  assert.strictEqual(a.scoreSpeech("oui", ["lui"]).score, 0,
    "oui and lui are a letter apart and are not the same word");
  assert.strictEqual(a.scoreSpeech("merci", ["mardi"]).score, 0, "two letters out is a miss");
});

test("the pass mark is seven words in ten, not any word at all", function () {
  const a = loadApp();
  const four = "je voudrais un cafe";
  /* Written out rather than read from the app: a test that borrows the
     threshold it is checking agrees with whatever the app happens to hold. */
  assert.ok(a.scoreSpeech(four, ["je voudrais un the"]).score >= 0.7, "three of four passes");
  assert.ok(a.scoreSpeech(four, ["je voudrais deux thes"]).score < 0.7, "two of four does not");
});

test("the pronunciation drill asks only to speak, and only words already met", function () {
  const a = loadApp({ hears: [], voices: [NEURAL_FR] });
  freshSrs(a, "fr");
  const c = a.course();
  const met = c.items.slice(0, 12);
  met.forEach(function (it) { a.gradeItem(it.id, true); });

  const q = a.buildPractice(c, "speak");
  assert.strictEqual(q.length, 10, "ten at a time");
  const seen = {};
  met.forEach(function (it) { seen[it.id] = true; });
  q.forEach(function (ex) {
    assert.strictEqual(ex.kind, "speak", "the drill fixes the shape of the question");
    assert.ok(seen[ex.item.id], "a drill is no place to meet a word for the first time");
  });
});

test("the drill does not wait on a device that can read the words out", function () {
  const a = loadApp({ hears: [] });
  freshSrs(a, "fr");
  const c = a.course();
  c.items.slice(0, 4).forEach(function (it) { a.gradeItem(it.id, true); });
  assert.strictEqual(a.practiceItems("speak", c).length, 4,
    "the mouth is what is being practised; hearing the model is a bonus");
  assert.strictEqual(a.practiceItems("listen", c).length, 0, "where the ear needs one");
});

test("a browser that cannot listen is not asked to", function () {
  const quiet = loadApp();
  freshSrs(quiet, "fr");
  quiet.course().items.slice(0, 4).forEach(function (it) { quiet.gradeItem(it.id, true); });
  assert.strictEqual(quiet.canListen, false);
  quiet.startPractice("speak");
  assert.strictEqual(quiet.session(), null, "no session where nothing can be heard");
  const html = quiet.pagePractice();
  assert.ok(html.indexOf('data-practice="speak" disabled') > -1, "and the card says so");
  assert.ok(html.indexOf("Chrome, Edge or Safari") > -1, "and says where it does work");

  const heard = loadApp({ hears: [] });
  freshSrs(heard, "fr");
  heard.course().items.slice(0, 4).forEach(function (it) { heard.gradeItem(it.id, true); });
  assert.strictEqual(heard.canListen, true);
  const ok = heard.pagePractice();
  assert.ok(ok.indexOf('data-practice="speak"') > -1
    && ok.indexOf('data-practice="speak" disabled') === -1, "where it does, the card is ready");
});

/* The kind is drawn at random, so these plant the question they are about. */
function frWord(pick) {
  /* The item is chosen before the app that will hear it is loaded, because the
     stub recogniser has to be told what to say back. */
  const a = loadApp();
  a.setActive("fr");
  const items = a.course().items;
  return pick ? items.filter(pick)[0] : items[0];
}

function speakSession(a, item) {
  a.startLesson(a.course().lessons[0]);
  const s = a.session();
  s.queue[s.idx] = { id: item.id, item: item, kind: "speak" };
  s.state = "ask";
  return s;
}

test("the recording is the answer: it is checked the moment it ends", function () {
  const item = frWord();
  const a = loadApp({ hears: [item.tgt] });
  freshSrs(a, "fr");
  const s = speakSession(a, item);
  a.startMic();

  assert.strictEqual(s.listening, false, "the microphone is let go");
  assert.strictEqual(s.state, "feedback", "and nothing is waiting on a Check button");
  assert.strictEqual(s.lastOk, true);
  assert.strictEqual(s.correct, 1);
  assert.strictEqual(a.srsOf(item.id).box, 1, "the word moves on like any other");
  assert.strictEqual(a.recordings[0].lang, a.course().tts, "asked for in the right language");
  assert.ok(a.recordings[0].alternatives > 1, "with room for the engine's other guesses");
});

test("a phrase mostly said passes, one mostly missed does not", function () {
  /* The shape of the phrase is planted rather than found: what is being
     checked is the mark the lesson puts on a part-heard answer, and no course
     owes this test a phrase of exactly four words. */
  const phrase = { id: frWord().id, kind: "p",
                   tgt: "je voudrais un cafe", en: "I would like a coffee" };

  const most = loadApp({ hears: ["je voudrais un the"] });
  freshSrs(most, "fr");
  speakSession(most, phrase);
  most.startMic();
  assert.strictEqual(most.session().lastOk, true, "three words of the four is a pass");

  const few = loadApp({ hears: ["je voudrais deux thes"] });
  freshSrs(few, "fr");
  speakSession(few, phrase);
  few.startMic();
  assert.strictEqual(few.session().lastOk, false, "two of the four is not");
});

test("a word that did not come through is a miss, and comes back to be said", function () {
  const item = frWord();
  const a = loadApp({ hears: ["something else entirely"] });
  freshSrs(a, "fr");
  const s = speakSession(a, item);
  const was = s.queue.length;
  a.startMic();

  assert.strictEqual(s.lastOk, false);
  assert.strictEqual(s.mistakes, 1);
  assert.strictEqual(s.hearts, 4, "in a lesson it costs a heart like any other answer");
  assert.strictEqual(s.queue.length, was + 1, "and the word is queued again");
  assert.strictEqual(s.queue[s.queue.length - 1].kind, "speak",
    "to be said, not to be picked out of a list");
});

test("a microphone that will not start is not a wrong answer", function () {
  const item = frWord();
  const a = loadApp({ hears: "not-allowed" });
  freshSrs(a, "fr");
  const s = speakSession(a, item);
  a.startMic();

  assert.strictEqual(s.state, "ask", "the question is still waiting");
  assert.strictEqual(s.answered, 0, "nothing was answered");
  assert.strictEqual(s.hearts, 5, "and nothing was lost");
  assert.strictEqual(s.micErr, "not-allowed");
  assert.strictEqual(a.srsOf(item.id).seen, 0, "the word was not graded either");
  assert.ok(a.micSays("not-allowed").indexOf("microphone") > -1, "and the page says what to do");
});

test("silence is told apart from a microphone that never opened", function () {
  const item = frWord();
  const a = loadApp({ hears: "no-speech" });
  freshSrs(a, "fr");
  const s = speakSession(a, item);
  a.startMic();
  assert.strictEqual(s.micErr, "no-speech");
  assert.notStrictEqual(a.micSays("no-speech"), a.micSays("not-allowed"),
    "two different things to do about it");
});

test("the question shows the phrase, the meaning and which words came through", function () {
  const item = frWord(function (x) { return wordCount(x.tgt) > 1; });
  const a = loadApp({ hears: [firstWord(item.tgt)], voices: [NEURAL_FR] });
  freshSrs(a, "fr");
  const s = speakSession(a, item);
  let html = a.bodyFor(s.queue[s.idx], false);
  assert.ok(html.indexOf('id="mic"') > -1, "a microphone to tap");
  assert.strictEqual(html.indexOf('id="mic" disabled'), -1, "live, where the browser can listen");
  assert.ok(html.indexOf(item.en) > -1, "and what the phrase means");

  a.startMic();
  html = a.bodyFor(s.queue[s.idx], true);
  const said = a.session().said.marks;
  assert.ok(html.indexOf('<span class="ok">' + said[0].word + '</span>') > -1,
    "the word that came through is marked as heard");
  assert.ok(html.indexOf('<span class="no">' + said[said.length - 1].word + '</span>') > -1,
    "and the one that did not is marked as missed");
  assert.ok(html.indexOf("Heard:") > -1, "with what the recogniser actually heard");
});

test("where there is nothing to record with, the microphone is not offered", function () {
  const a = loadApp({ voices: [NEURAL_FR] });
  freshSrs(a, "fr");
  const item = a.course().items[0];
  const s = speakSession(a, item);
  const html = a.bodyFor(s.queue[s.idx], false);
  assert.ok(html.indexOf('id="mic" disabled') > -1, "the button is dead");
  assert.ok(html.indexOf("cannot listen") > -1, "and the page says why");
  assert.ok(a.footFor(s.queue[s.idx]).indexOf('id="skip"') > -1, "there is still a way past it");
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

/* ---------- streak freezes ---------- */

/* The clock is the app's own: these set lastDay by hand, the way a calendar
   would have, rather than waiting a day to find out. */
function dayStamp(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0")
       + "-" + String(d.getDate()).padStart(2, "0");
}

function streakOf(a, opts) {
  const S = a.state();
  S.streak = opts.streak;
  S.lastDay = dayStamp(opts.ago);
  S.freezeEarned = opts.earned || 0;
  S.freezeUsed = opts.used || 0;
  S.thawed = null;
  return S;
}

test("a freeze is earned every five days and no more than two are held", function () {
  const a = loadApp();
  freshSrs(a, "fr");
  const S = a.state();
  S.streak = 0; S.lastDay = null; S.freezeEarned = 0; S.freezeUsed = 0;

  /* Written out rather than read from the app: a test that borrows the
     interval it is checking agrees with whatever the app happens to hold. */
  /* Written out rather than counted from the app: one at five, a second at
     ten, and nothing after that because two is as many as you can hold. */
  const BY_DAY = [0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2];
  for (let day = 1; day <= 15; day++) {
    S.lastDay = day === 1 ? null : dayStamp(1);
    a.touchStreak();
    assert.strictEqual(S.streak, day, "day " + day);
    assert.strictEqual(a.freezesHeld(), BY_DAY[day - 1],
      "on day " + day + " there should be " + BY_DAY[day - 1]);
  }
});

test("a freeze earned at the cap is not banked for later", function () {
  const a = loadApp();
  freshSrs(a, "fr");
  const S = a.state();
  S.streak = 0; S.lastDay = null; S.freezeEarned = 0; S.freezeUsed = 0;
  for (let day = 1; day <= 15; day++) {
    S.lastDay = day === 1 ? null : dayStamp(1);
    a.touchStreak();
  }
  /* Fifteen days is three five-day marks, but the third passed while both
     hands were full, so it was never earned and cannot turn up afterwards. */
  S.lastDay = dayStamp(3);
  a.settleStreak();
  assert.strictEqual(S.streak, 15, "two freezes cover the two days missed");
  assert.strictEqual(a.freezesHeld(), 0, "and there is nothing left behind them");
});

test("a count that arrives too high is still held to the cap", function () {
  const a = loadApp();
  freshSrs(a, "fr");
  const S = a.state();
  /* Two devices merge by taking the larger count each has seen, so a figure
     above the cap can arrive without either of them ever earning one. */
  S.freezeEarned = 9; S.freezeUsed = 0;
  assert.strictEqual(a.freezesHeld(), 2);
});

test("a day missed costs a freeze, not the streak", function () {
  const a = loadApp();
  freshSrs(a, "fr");
  const S = streakOf(a, { streak: 9, ago: 2, earned: 1 });   /* yesterday was missed */

  assert.strictEqual(a.settleStreak(), 1, "one freeze goes");
  assert.strictEqual(S.streak, 9, "and the streak stands");
  assert.strictEqual(a.freezesHeld(), 0);

  a.touchStreak();
  assert.strictEqual(S.streak, 10, "studying today carries on from nine");
});

test("the gap is charged once, however long you stay away afterwards", function () {
  const a = loadApp();
  freshSrs(a, "fr");
  const S = streakOf(a, { streak: 9, ago: 2, earned: 2 });
  assert.strictEqual(a.settleStreak(), 1);
  /* Opening the app again the same day must not spend a second one. */
  assert.strictEqual(a.settleStreak(), 0, "the same day costs nothing more");
  assert.strictEqual(a.settleStreak(), 0);
  assert.strictEqual(a.freezesHeld(), 1, "the second freeze is still in hand");
});

test("two days away cost two freezes", function () {
  const a = loadApp();
  freshSrs(a, "fr");
  const S = streakOf(a, { streak: 20, ago: 3, earned: 2 });
  assert.strictEqual(a.settleStreak(), 2);
  assert.strictEqual(S.streak, 20);
  assert.strictEqual(a.freezesHeld(), 0);
});

test("a gap wider than the freezes ends the streak, and spends none of them", function () {
  const a = loadApp();
  freshSrs(a, "fr");
  const S = streakOf(a, { streak: 30, ago: 5, earned: 2 });  /* four days missed */
  a.settleStreak();
  assert.strictEqual(S.streak, 0, "thirty days are gone");
  assert.strictEqual(S.lastDay, null);
  assert.strictEqual(a.freezesHeld(), 2,
    "and the freezes are kept rather than burnt on a streak they could not save");
});

test("coming back the next day spends nothing", function () {
  const a = loadApp();
  freshSrs(a, "fr");
  const S = streakOf(a, { streak: 4, ago: 1, earned: 2 });
  assert.strictEqual(a.settleStreak(), 0, "yesterday is not a day missed");
  assert.strictEqual(a.freezesHeld(), 2);
  assert.strictEqual(S.thawed, null, "and there is nothing to tell anyone about");
  assert.strictEqual(a.thawNote(), "");
  a.touchStreak();
  assert.strictEqual(S.streak, 5);
});

test("the streak is settled as the app opens, before a number is drawn", function () {
  /* Otherwise the flame says nine through a week away and drops to one the
     moment you answer a question. */
  const a = loadApp({ stored: {
    active: "fr", streak: 9, lastDay: dayStamp(2), today: null, todayXp: 0,
    freezeEarned: 1, freezeUsed: 0, courses: {}
  } });
  assert.strictEqual(a.state().streak, 9, "the freeze was spent on the way up");
  assert.strictEqual(a.freezesHeld(), 0);
  assert.ok(a.state().thawed, "and the page has something to say about it");
});

test("a course never started has nothing to settle", function () {
  const a = loadApp();
  freshSrs(a, "fr");
  const S = a.state();
  S.streak = 0; S.lastDay = null; S.freezeEarned = 2; S.freezeUsed = 0;
  assert.strictEqual(a.settleStreak(), 0);
  assert.strictEqual(a.freezesHeld(), 2);
});

test("the day before is a real calendar day", function () {
  const a = loadApp();
  assert.strictEqual(a.dayBefore("2026-03-01"), "2026-02-28", "not a leap year");
  assert.strictEqual(a.dayBefore("2024-03-01"), "2024-02-29", "but this one is");
  assert.strictEqual(a.dayBefore("2026-01-01"), "2025-12-31", "and the year turns");
});

test("what the freeze saved is said once, on the day it is noticed", function () {
  const a = loadApp();
  freshSrs(a, "fr");
  streakOf(a, { streak: 12, ago: 2, earned: 1 });
  a.settleStreak();
  const html = a.pageLearn2();
  assert.ok(html.indexOf("12-day streak") > -1, "it should say what was kept");
  assert.ok(html.indexOf("None left") > -1, "and that there is no second chance");

  /* Tomorrow it is yesterday's news. */
  a.state().thawed.day = "2020-01-01";
  assert.strictEqual(a.thawNote(), "");
});

test("the freezes are shown whether or not any are held", function () {
  const a = loadApp();
  freshSrs(a, "fr");
  streakOf(a, { streak: 3, ago: 0, earned: 0 });
  let row = a.freezeRow();
  assert.ok(row.indexOf("No streak freeze yet") > -1);
  assert.ok(row.indexOf("2 more days") > -1, "and how near the next one is");

  streakOf(a, { streak: 10, ago: 0, earned: 2 });
  row = a.freezeRow();
  assert.ok(row.indexOf("2 streak freezes") > -1);
  assert.ok(row.indexOf("as many as you can hold") > -1);
});

test("two devices never put a spent freeze back", function () {
  const a = loadApp();
  /* Earned and used only go up, so the larger of each is the one that has
     seen more. Taking the larger of what is *held* would restore a freeze
     the other device had already spent. */
  const here = { streak: 10, lastDay: "2026-03-10", freezeEarned: 2, freezeUsed: 0, courses: {} };
  const there = { streak: 10, lastDay: "2026-03-10", freezeEarned: 2, freezeUsed: 2, courses: {} };
  const both = a.mergeState(here, there);
  assert.strictEqual(both.freezeEarned, 2);
  assert.strictEqual(both.freezeUsed, 2);

  const back = a.mergeState(there, here);
  assert.strictEqual(back.freezeUsed, 2, "whichever way round they meet");
});

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

/* The number beside the flame is the days already banked; the fire itself is
   today. Opening the app the morning after should find it grey, which is the
   only thing on the page saying today's lesson is still owed. */
test("the morning after, the fire is cold and the number is not", function () {
  const a = loadApp();
  a.setActive("fr");
  const S = a.state();
  S.streak = 5;
  S.lastDay = yesterday();

  assert.strictEqual(a.studiedToday(), false);
  const top = a.shell();
  assert.ok(/flame--cold/.test(top), "the flame is drawn cold");
  assert.ok(/not kept yet today/.test(top),
    "and says so in words: grey on its own is nothing to a screen reader");
  assert.ok(/local_fire_department<\/span>5</.test(top),
    "five days were earned and are still shown");

  const css = fs.readFileSync(PAGE, "utf8");
  assert.ok(/\.flame\{color:var\(--color-accent-ink\)\}/.test(css),
    "a lit flame is the accent gold");
  assert.ok(/\.flame--cold\{color:var\(--color-text-muted\)\}/.test(css),
    "and a cold one is the muted grey");
});

test("finishing a lesson lights it", function () {
  const a = loadApp();
  a.setActive("fr");
  freshSrs(a);
  const S = a.state();
  S.streak = 5;
  S.lastDay = yesterday();
  assert.ok(/flame--cold/.test(a.shell()), "cold to begin with");

  playLesson(a);
  assert.strictEqual(a.studiedToday(), true);
  const top = a.shell();
  assert.ok(!/flame--cold/.test(top), "the lesson lit it");
  assert.ok(/, kept today/.test(top), "and the label followed the colour");
  assert.ok(/local_fire_department<\/span>6</.test(top), "on a sixth day");
});

test("the Progress page greys the flame's tile as well", function () {
  const a = loadApp();
  a.setActive("fr");
  const S = a.state();
  S.streak = 5;
  S.lastDay = yesterday();

  const tileOf = function (html) {
    const m = html.match(/stat-icon (\w+)"><span class="ms" aria-hidden="true">local_fire_department/);
    assert.ok(m, "no flame tile on the Progress page");
    return m[1];
  };

  const cold = a.pageProgress();
  assert.strictEqual(tileOf(cold), "cold", "a grey tile, not the gold one");
  assert.ok(/Not kept yet today/.test(cold), "and the card says why");
  assert.ok(/>5</.test(cold), "the five days are still on the card");

  a.touchStreak();
  const lit = a.pageProgress();
  assert.strictEqual(tileOf(lit), "gold");
  assert.ok(!/Not kept yet today/.test(lit), "and the note goes once it is kept");
});

/* ---------- course content ---------- */

/* ---------- a question never offers the same word twice ---------- */

test("no two options read the same, on either side", function () {
  const a = loadApp({ voices: [NEURAL_FR] });
  /* French says la fille for the girl and for the daughter. A question that
     put both on the table would mark one of two right answers wrong -- and
     "what does la fille mean?" would do it the other way round. */
  a.LANGS.forEach(function (lg) {
    a.setActive(lg);
    a.prog().srs = {}; a.prog().crowns = {};
    const c = a.course();
    c.items.forEach(function (item) {
      ["pick_tgt", "pick_en", "listen"].forEach(function (kind) {
        const ex = a.makeExercise(item, 2, c, true, kind);
        const tgt = {}, en = {};
        ex.options.forEach(function (o) {
          const t = a.loose(o.tgt), e = a.norm(o.en);
          assert.ok(!tgt[t], lg + "/" + item.id + " (" + kind + ") offers " + o.tgt + " twice");
          assert.ok(!en[e], lg + "/" + item.id + " (" + kind + ") offers " + o.en + " twice");
          tgt[t] = en[e] = true;
        });
        assert.strictEqual(ex.options.length, 4, lg + "/" + item.id + " lost an option");
        assert.ok(ex.options.filter(function (o) { return o.id === item.id; }).length === 1,
          lg + "/" + item.id + " is not among its own options");
      });
    });
  });
});

test("a word a course teaches twice is still offered once", function () {
  const a = loadApp();
  a.setActive("fr");
  a.prog().srs = {}; a.prog().crowns = {};
  const c = a.course();
  const girl = c.items.filter(function (it) { return it.id === "fr-14-3"; })[0];
  const daughter = c.items.filter(function (it) { return it.id === "fr-2-5"; })[0];
  assert.ok(girl && daughter, "the two readings of la fille should both be taught");
  assert.strictEqual(girl.tgt, daughter.tgt, "and they are the same word");

  for (let i = 0; i < 40; i++) {
    const ex = a.makeExercise(girl, 2, c, false, "pick_en");
    assert.strictEqual(ex.options.filter(function (o) { return o.id === daughter.id; }).length, 0,
      "daughter is also what la fille means, so it cannot be a wrong answer");
  }
});

test("every course carries the same shape", function () {
  const a = loadApp();
  eq(a.LANGS, ["es", "fr", "de", "it", "la", "ru", "en"]);
  a.LANGS.forEach(function (lg) {
    const c = a.COURSES[lg];
    assert.strictEqual(c.units.length, 7, lg + " should have seven units");
    /* Every unit runs to six lessons now: three of words and three of the
       phrases made from them, alternating. */
    eq(c.units.map(function (u) { return u.lessons.length; }), [6, 6, 6, 6, 6, 6, 6],
       lg + " has the wrong number of lessons in a unit");
    assert.strictEqual(c.lessons.length, 42, lg + " should have forty-two lessons");
    assert.strictEqual(c.items.length, 336, lg + " should have 336 items");
    c.lessons.forEach(function (l) {
      assert.ok(l.kind === "w" || l.kind === "p", "a lesson is words or phrases");
      /* Lessons alternate: ten words, then six phrases built from them. */
      assert.strictEqual(l.items.length, l.kind === "w" ? 10 : 6,
        lg + "/" + l.id + " has the wrong number of items");
      l.items.forEach(function (it) {
        assert.strictEqual(it.kind, l.kind, lg + "/" + it.id + " does not match its lesson");
      });
    });
    c.units.forEach(function (u) {
      /* Joined into a string: both sides are built inside the vm, and a deep
         comparison of two arrays from there trips over the realm. */
      assert.strictEqual(u.lessons.map(function (l) { return l.kind; }).join(""),
        u.lessons.map(function (l, i) { return i % 2 === 0 ? "w" : "p"; }).join(""),
        lg + "/" + u.id + " should teach the words before the phrases made of them");
    });
    const vocab = c.lessons.filter(function (l) { return l.kind === "w"; });
    assert.strictEqual(vocab.length, 21, lg + " should have twenty-one vocabulary lessons");
    vocab.forEach(function (l) {
      assert.ok(l.items.length >= 5, lg + "/" + l.id + " cannot fill a five-pair match");
    });
  });
});

test("a lesson is named by the set it teaches, and no two share one", function () {
  const a = loadApp();
  a.LANGS.forEach(function (lg) {
    const seen = {};
    a.COURSES[lg].lessons.forEach(function (l) {
      const n = l.id.slice(lg.length + 1);
      assert.ok(/^\d+$/.test(n), lg + "/" + l.id + " is not numbered");
      assert.ok(!seen[n], lg + " teaches set " + n + " twice");
      seen[n] = true;
      assert.ok(l.items.length, lg + "/" + l.id + " teaches an empty set");
    });
  });
});

test("the lessons that were there before keep the ids progress was saved under", function () {
  const a = loadApp();
  /* A crown is kept against a lesson id. The four lessons added to Basics took
     the numbers after the last of the old ones for that reason: inserting them
     in the middle would have moved every crown onto the wrong lesson. */
  const ids = a.COURSES.fr.lessons.map(function (l) { return l.id; });
  for (let n = 0; n <= 13; n++) {
    assert.ok(ids.indexOf("fr-" + n) > -1, "fr-" + n + " is gone");
  }
  eq(a.COURSES.fr.units[0].lessons.map(function (l) { return l.id; }),
     ["fr-0", "fr-1", "fr-14", "fr-15", "fr-16", "fr-17"],
     "Basics keeps its two and carries the four new ones after them");
  eq(a.COURSES.fr.units[1].lessons.map(function (l) { return l.id; }),
     ["fr-2", "fr-3", "fr-18", "fr-19", "fr-20", "fr-21"],
     "People keeps its two and carries four more");
  eq(a.COURSES.fr.units[2].lessons.map(function (l) { return l.id; }),
     ["fr-4", "fr-5", "fr-22", "fr-23", "fr-24", "fr-25"],
     "and so does Food & travel");
  eq(a.COURSES.fr.units[3].lessons.map(function (l) { return l.id; }),
     ["fr-6", "fr-7", "fr-26", "fr-27", "fr-28", "fr-29"],
     "and Everyday life, the one written from the corpus");
  eq(a.COURSES.fr.units[6].lessons.map(function (l) { return l.id; }),
     ["fr-12", "fr-13", "fr-38", "fr-39", "fr-40", "fr-41"],
     "down to the last one, which keeps the two it opened with");
  eq(a.COURSES.fr.units[0].lessons.map(function (l) { return l.title; }),
     ["Greetings", "First phrases", "Everyday words", "Saying who you are",
      "Small words", "Putting it together"],
     "each one keeps its own name, which is what the path prints");
});

test("the path counts the lessons a unit really has", function () {
  const a = loadApp();
  freshSrs(a, "fr");
  const html = a.pageLearn();
  /* The trophy at the end of a unit used to say "both lessons", which Basics
     stopped being the moment it grew past two. Every unit is six now, so what
     is checked is that the number is counted and not written down: a trophy
     that says six for a unit of two is the same bug the other way round. */
  const says = html.split("Finish all ").length - 1;
  assert.strictEqual(says, 7, "one trophy per unit");
  assert.strictEqual(html.split("Finish all 6 lessons").length - 1, 7,
    "and each of them counts six");
  assert.strictEqual(html.indexOf("both lessons"), -1);

  /* Every unit is six at the moment, so the page would read the same whether
     the number is counted or written down. Take a lesson away and it cannot. */
  a.COURSES.fr.units[0].lessons.pop();
  const five = a.pageLearn();
  assert.ok(five.indexOf("Finish all 5 lessons") > -1,
    "the trophy counts the lessons rather than knowing how many there are");
});

test("the new lessons are reachable in order, not locked behind the old ones", function () {
  const a = loadApp();
  freshSrs(a, "fr");
  const ids = a.COURSES.fr.units[0].lessons.map(function (l) { return l.id; });
  assert.strictEqual(a.unlocked("fr-0"), true, "the first is always open");
  assert.strictEqual(a.unlocked("fr-14"), false, "the rest wait their turn");

  ids.forEach(function (id) {
    assert.strictEqual(a.unlocked(id), true, id + " should be open by now");
    a.prog().crowns[id] = 1;
  });
  assert.strictEqual(a.unlocked("fr-2"), true,
    "and the unit after Basics opens once Basics is done");
});

/* The same rule for the units that grew: the phrases lean on the words their
   own unit teaches, and on Basics before it. */
test("every unit that grew leans on the words it teaches", function () {
  const a = loadApp();
  const ADDED = { 0: ["15", "17"], 1: ["19", "21"], 2: ["23", "25"], 3: ["27", "29"],
                  4: ["31", "33"], 5: ["35", "37"], 6: ["39", "41"] };
  a.LANGS.forEach(function (lg) {
    Object.keys(ADDED).forEach(function (ui) {
      const unit = a.COURSES[lg].units[+ui];
      const taught = {}, stems = {};
      a.COURSES[lg].units.slice(0, +ui + 1).forEach(function (u) {
        u.lessons.forEach(function (l) {
          if (l.kind === "w") l.items.forEach(function (it) {
            a.words(it.tgt).forEach(function (w) {
              const k = a.loose(w);
              taught[k] = true;
              if (k.length > 3) stems[k.slice(0, 3)] = true;
            });
          });
        });
      });
      ADDED[ui].forEach(function (n) {
        const lesson = unit.lessons.filter(function (l) { return l.id === lg + "-" + n; })[0];
        assert.ok(lesson, lg + " has no lesson " + n);
        const met = {};
        lesson.items.forEach(function (it) {
          a.words(it.tgt).forEach(function (w) {
            const k = a.loose(w);
            if (taught[k]) { met[k] = true; return; }
            /* Matched on the first three letters where the whole word does
               not match, because a word taught in one shape turns up in a
               sentence in another: Latin teaches legere and says lego, nox
               and says nocte. Comparing whole words would call those new
               vocabulary, which is the opposite of what is being checked. */
            const stem = k.slice(0, 3);
            if (k.length > 3 && stems[stem]) met[stem] = true;
          });
        });
        assert.ok(Object.keys(met).length >= 4,
          lg + "/" + lesson.id + " leans on only " + Object.keys(met).length
          + " of the words taught before it");
      });
    });
  });
});

test("the new phrases in Basics are built from the words Basics teaches", function () {
  const a = loadApp();
  a.LANGS.forEach(function (lg) {
    const basics = a.COURSES[lg].units[0];
    const taught = {};
    basics.lessons.forEach(function (l) {
      if (l.kind === "w") l.items.forEach(function (it) {
        a.words(it.tgt).forEach(function (w) { taught[a.loose(w)] = true; });
      });
    });
    /* Only the lessons that were added: the ones that came before lean on
       words the course never lists on its own. Four distinct words, not a
       share of the whole phrase -- a sentence is mostly the grammar holding it
       up, and a course that only ever said what it had already taught could
       not make a sentence at all. */
    ["15", "17"].forEach(function (n) {
      const lesson = basics.lessons.filter(function (l) { return l.id === lg + "-" + n; })[0];
      assert.ok(lesson, lg + " has no lesson " + n);
      const met = {};
      lesson.items.forEach(function (it) {
        a.words(it.tgt).forEach(function (w) {
          if (taught[a.loose(w)]) met[a.loose(w)] = true;
        });
      });
      assert.ok(Object.keys(met).length >= 4,
        lg + "/" + lesson.id + " leans on only " + Object.keys(met).length
        + " of the words Basics teaches");
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

/* ---------- carrying progress between devices ---------- */

const SYNC = { code: "abcd-1234-wxyz", url: "https://sync.example" };

function device(server) {
  const a = loadApp({ server: server });
  freshSrs(a, "fr");
  a.setSync({ code: SYNC.code, url: SYNC.url });
  return a;
}
function synced(a) { return new Promise(function (res) { a.syncNow(res); }); }

test("a word is known by whichever device knows more about it", function () {
  const a = loadApp();
  /* More answers is more history; the device that has been away does not undo
     the one that has been used. */
  const old = { box: 1, due: 10, seen: 1, wrong: 0 };
  const fresh = { box: 3, due: 99, seen: 4, wrong: 1 };
  eq(a.mergeSrs(old, fresh), fresh);
  eq(a.mergeSrs(fresh, old), fresh, "and it does not matter which way round");
  eq(a.mergeSrs(null, old), old, "a word only one device has met still arrives");
  eq(a.mergeSrs(old, null), old);
});

test("answered the same number of times, the later schedule wins", function () {
  const a = loadApp();
  const earlier = { box: 2, due: 100, seen: 3, wrong: 0 };
  const later = { box: 3, due: 500, seen: 3, wrong: 0 };
  eq(a.mergeSrs(earlier, later), later);
  eq(a.mergeSrs(later, earlier), later);
});

test("XP is the larger of the two, never the sum", function () {
  const a = loadApp();
  /* Both copies count the same past. Adding them would pay twice for every
     lesson done before the two devices parted. */
  const out = a.mergeState({ courses: { fr: { xp: 120, crowns: {}, srs: {} } } },
                           { courses: { fr: { xp: 80, crowns: {}, srs: {} } } });
  assert.strictEqual(out.courses.fr.xp, 120);
});

test("a lesson keeps the most crowns either device won for it", function () {
  const a = loadApp();
  const out = a.mergeState({ courses: { fr: { xp: 0, crowns: { "fr-0": 3, "fr-1": 1 }, srs: {} } } },
                           { courses: { fr: { xp: 0, crowns: { "fr-0": 1, "fr-2": 5 }, srs: {} } } });
  eq(out.courses.fr.crowns, { "fr-0": 3, "fr-1": 1, "fr-2": 5 });
});

test("an achievement keeps the moment it was actually earned", function () {
  const a = loadApp();
  const out = a.mergeState({ courses: { fr: { xp: 0, crowns: {}, srs: {}, ach: { first: 5000 } } } },
                           { courses: { fr: { xp: 0, crowns: {}, srs: {}, ach: { first: 9000, week: 7000 } } } });
  assert.strictEqual(out.courses.fr.ach.first, 5000, "the earlier stamp is the true one");
  assert.strictEqual(out.courses.fr.ach.week, 7000, "and one side alone still counts");
});

test("the streak and the last day come from whichever went further", function () {
  const a = loadApp();
  const out = a.mergeState({ streak: 2, lastDay: "2026-03-01", courses: {} },
                           { streak: 9, lastDay: "2026-03-04", courses: {} });
  assert.strictEqual(out.streak, 9);
  assert.strictEqual(out.lastDay, "2026-03-04");
});

test("today's XP belongs to today, and a stale day is dropped", function () {
  const a = loadApp();
  const same = a.mergeState({ today: "2026-03-04", todayXp: 10, courses: {} },
                            { today: "2026-03-04", todayXp: 25, courses: {} });
  assert.strictEqual(same.todayXp, 25, "the same day: each saw part of it");

  const stale = a.mergeState({ today: "2026-03-04", todayXp: 30, courses: {} },
                             { today: "2026-03-01", todayXp: 90, courses: {} });
  assert.strictEqual(stale.today, "2026-03-04");
  assert.strictEqual(stale.todayXp, 30, "yesterday's 90 is not today's goal");
});

test("the course you have open is this device's own business", function () {
  const a = loadApp();
  assert.strictEqual(a.mergeState({ active: "fr", courses: {} }, { active: "de", courses: {} }).active,
    "fr", "the phone being on German does not switch the laptop");
  assert.strictEqual(a.mergeState({ active: null, courses: {} }, { active: "de", courses: {} }).active,
    "de", "but a device that has not chosen yet takes the other one's course");
});

test("merging is the same whichever device asks", function () {
  const a = loadApp();
  const one = { active: "fr", streak: 4, lastDay: "2026-03-02", today: "2026-03-02", todayXp: 10,
                courses: { fr: { xp: 50, crowns: { "fr-0": 2 }, srs: { "fr-0-1": { box: 2, due: 20, seen: 2, wrong: 0 } } } } };
  const two = { active: "fr", streak: 1, lastDay: "2026-03-03", today: "2026-03-03", todayXp: 4,
                courses: { fr: { xp: 30, crowns: { "fr-0": 5 }, srs: { "fr-0-2": { box: 1, due: 9, seen: 1, wrong: 1 } } } } };
  /* Both sides go through JSON: objects made inside the vm carry that realm's
     prototypes, which deepStrictEqual refuses even when the contents match. */
  eq(a.mergeState(one, two), JSON.parse(JSON.stringify(a.mergeState(two, one))));
});

test("rubbish from the server leaves this device alone", function () {
  const a = loadApp();
  const mine = { active: "fr", streak: 3, courses: {} };
  assert.strictEqual(a.mergeState(mine, null), mine);
  assert.strictEqual(a.mergeState(mine, "nonsense"), mine);
  assert.strictEqual(a.mergeState(mine, { active: "klingon", courses: {} }).active, "fr");
  /* A device that has not picked a course takes the other one's -- unless
     that is not a course this app teaches. */
  assert.strictEqual(
    a.mergeState({ active: null, courses: {} }, { active: "klingon", courses: {} }).active, null,
    "a course that does not exist is dropped rather than opened");
});

test("a code is made of the letters that cannot be misread", function () {
  const a = loadApp();
  const code = a.newCode();
  assert.ok(/^[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/.test(code), code + " is the wrong shape");
  /* i, l, o and u are left out: read off one screen and typed into another,
     they turn into 1, 1, 0 and v. */
  assert.strictEqual(/[ilou]/.test(code), false, code + " holds a letter that gets misread");
  assert.notStrictEqual(a.newCode(), a.newCode(), "two codes in a row are not the same code");
});

test("a code typed by hand is read as it was meant", function () {
  const a = loadApp();
  assert.strictEqual(a.tidyCode("ABCD-1234-WXYZ"), "abcd-1234-wxyz");
  assert.strictEqual(a.tidyCode("  abcd 1234 wxyz "), "abcd-1234-wxyz", "spaces and no dashes");
  assert.strictEqual(a.tidyCode("abcdI234wxyz"), "abcd1234wxyz".slice(0, 4) + "-1234-wxyz",
    "a capital I was a one");
  assert.strictEqual(a.tidyCode("abcd-1234-wxyO"), "abcd-1234-wxy0", "and an O was a zero");
  assert.strictEqual(a.tidyCode("abcd-1234"), "", "too short is not a code");
  assert.strictEqual(a.tidyCode("abcd-1234-wxyz-0000"), "", "nor too long");
  assert.strictEqual(a.tidyCode(""), "");
  assert.strictEqual(a.tidyCode(null), "");
});

atest("two devices end up knowing everything both of them learnt", async function () {
  const server = {};
  const laptop = device(server);
  const items = laptop.course().items;
  laptop.gradeItem(items[0].id, true);
  laptop.gradeItem(items[1].id, true);
  await synced(laptop);

  const phone = device(server);
  phone.gradeItem(items[5].id, true);
  await synced(phone);

  assert.strictEqual(phone.srsOf(items[0].id).seen, 1, "the laptop's words came down");
  assert.strictEqual(phone.srsOf(items[5].id).seen, 1, "and its own are still here");

  await synced(laptop);
  assert.strictEqual(laptop.srsOf(items[5].id).seen, 1, "and the phone's word went home");
});

atest("the first device to use a code is not an error", async function () {
  const server = {};
  const a = device(server);
  a.gradeItem(a.course().items[0].id, true);
  const ok = await synced(a);
  assert.strictEqual(ok, true, "nothing stored yet simply means this device is first");
  assert.strictEqual(a.syncState().err, "");
  assert.ok(server.slots[SYNC.code], "and its progress is now up there");
});

atest("it reads before it writes, so a device that was away adds instead of flattening", async function () {
  const server = {};
  const a = device(server);
  await synced(a);
  const mine = server.calls.filter(function (c) { return c.url.indexOf("/v1/") > -1; });
  assert.strictEqual(mine[0].method, "GET");
  assert.strictEqual(mine[1].method, "PUT");
});

atest("a server that cannot be reached costs nothing", async function () {
  const server = { down: true };
  const a = device(server);
  a.gradeItem(a.course().items[0].id, true);
  const ok = await synced(a);
  assert.strictEqual(ok, false);
  assert.strictEqual(a.srsOf(a.course().items[0].id).seen, 1, "the lesson is still here");
  assert.ok(a.syncState().err, "and the panel has something to say");
  assert.ok(a.syncSays().indexOf("Nothing is lost") > -1);

  server.down = false;
  assert.strictEqual(await synced(a), true, "and it goes across next time");
  assert.strictEqual(a.syncState().err, "", "with the warning gone");
});

atest("an error from the server is not read as progress", async function () {
  const server = { status: 500 };
  const a = device(server);
  a.gradeItem(a.course().items[0].id, true);
  assert.strictEqual(await synced(a), false);
  assert.strictEqual(a.srsOf(a.course().items[0].id).seen, 1);
  assert.ok(a.syncSays().indexOf("500") > -1, "and says what came back");
});

atest("a write that did not land is not a sync", async function () {
  /* The read can go through and the write still fail. Counting that as done
     would leave the panel claiming progress is safe somewhere it is not. */
  const server = { putStatus: 500 };
  const a = device(server);
  a.gradeItem(a.course().items[0].id, true);
  assert.strictEqual(await synced(a), false);
  assert.strictEqual(a.syncState().at, 0, "nothing is claimed to have gone across");
  assert.ok(a.syncCard().indexOf("Not synced yet") > -1, "and the panel says so");
});

atest("without a code or an address nothing is sent anywhere", async function () {
  const server = {};
  const quiet = loadApp({ server: server });
  freshSrs(quiet, "fr");
  assert.strictEqual(quiet.syncOn(), false);
  assert.strictEqual(await synced(quiet), false);

  quiet.setSync({ code: SYNC.code, url: "" });
  assert.strictEqual(quiet.syncOn(), false, "a code with nowhere to send it is not sync");
  assert.strictEqual(await synced(quiet), false);

  quiet.setSync({ code: "", url: SYNC.url });
  assert.strictEqual(quiet.syncOn(), false, "nor an address with no code");
  assert.strictEqual(await synced(quiet), false);

  assert.strictEqual(server.calls.filter(function (c) { return c.url.indexOf("/v1/") > -1; }).length, 0);
});

atest("finishing a lesson carries it across by itself", async function () {
  const server = {};
  const a = device(server);
  playLesson(a);
  /* finish() asks for a sync; the answer lands a tick later. */
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.ok(server.slots[SYNC.code], "the lesson went up without being asked");
  assert.ok(server.slots[SYNC.code].courses.fr.xp > 0, "with the XP it earned");
});

test("a device already knows where to sync, so it only ever asks for the code", function () {
  const a = loadApp({ server: {} });
  freshSrs(a, "fr");
  /* The address of the deployed worker is in the page. Without it every
     device would have to be told where to look, which is a second thing to
     carry across and the one nobody would remember. */
  assert.ok(/^https:\/\/\S+$/.test(a.syncState().url), "a device starts out knowing the address");
  assert.strictEqual(a.syncCard().indexOf('id="syncurl"'), -1, "so it does not ask for one");
});

test("the panel asks for one thing at a time", function () {
  const a = loadApp({ server: {} });
  freshSrs(a, "fr");
  /* Cleared, which is how a device is pointed at someone else's server. */
  a.setSync({ url: "" });
  let html = a.syncCard();
  assert.ok(html.indexOf('id="syncurl"') > -1, "with nowhere to sync, it wants the address");
  assert.strictEqual(html.indexOf('id="syncnew"'), -1, "and nothing else yet");

  a.setSync({ url: SYNC.url });
  html = a.syncCard();
  assert.ok(html.indexOf('id="syncnew"') > -1, "with an address, it offers a code");
  assert.ok(html.indexOf('id="synccode"') > -1, "or takes the one the other device has");

  a.setSync({ code: SYNC.code, at: Date.now() - 3600000 });
  html = a.syncCard();
  assert.ok(html.indexOf(SYNC.code) > -1, "once on, it shows the code to type over there");
  assert.ok(html.indexOf("1 hour ago") > -1, "and when it last went across");
  assert.ok(html.indexOf('id="syncoff"') > -1, "with a way to stop");
});

test("a device that has never been used offers the panel at the front door", function () {
  const fresh = loadApp({ server: {} });
  /* The panel otherwise sits behind a course, and someone arriving on their
     phone has already chosen one -- over on the other device. */
  assert.ok(fresh.viewPicker().indexOf('id="synccode"') > -1,
    "a new device should be able to type its code before anything else");

  const used = loadApp({ server: {} });
  freshSrs(used, "fr");
  used.touchStreak();
  assert.strictEqual(used.viewPicker().indexOf('id="synccode"'), -1,
    "but swapping courses later is not the moment to talk about devices");
});

atest("a fresh device gets the other one's course along with its progress", async function () {
  const server = {};
  const laptop = device(server);
  laptop.gradeItem(laptop.course().items[0].id, true);
  laptop.addXp(30);
  await synced(laptop);

  const phone = loadApp({ server: server });
  assert.strictEqual(phone.state().active, null, "nothing chosen here yet");
  phone.setSync({ code: SYNC.code, url: SYNC.url });
  await synced(phone);
  assert.strictEqual(phone.state().active, "fr", "the course came across too");
  assert.strictEqual(phone.prog().xp, 30);
});

test("a mistyped code is turned away before the server hears about it", function () {
  const a = loadApp({ server: {} });
  freshSrs(a, "fr");
  a.setSync({ url: SYNC.url, err: "badcode" });
  assert.ok(a.syncCard().indexOf("twelve letters and numbers") > -1);
});

/* ---------- report ---------- */

(async function report() {
for (const t of waiting) {
  try {
    await t.fn();
    results.push({ name: t.name, ok: true });
  } catch (err) {
    results.push({ name: t.name, ok: false, err: err });
  }
}

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
})();
