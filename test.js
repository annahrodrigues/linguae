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
  startLesson: startLesson, startPractice: startPractice,
  submit: submit, advance: advance, tapPair: tapPair, hasVoiceFor: hasVoiceFor,
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
  const sandbox = {
    console: console,
    setTimeout() { return 0; },
    clearTimeout() {},
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
  if (opts.voices) {
    win.speechSynthesis = {
      getVoices() { return opts.voices; },
      speak() {},
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
    answerCurrent(a, o.wrongAt === undefined ? true : n !== o.wrongAt);
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
  eq(a.LANGS, ["es", "fr", "de", "it", "la"]);
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
