/*
 * Recorded audio for Linguae. No dependencies.
 *
 *   node tools/audio.js list [lang]      what to record, as TSV: id, BCP-47 tag, text
 *   node tools/audio.js words [lang]     the same, for the single words on the tiles
 *   node tools/audio.js manifest         scan assets/audio and write its index.json
 *   node tools/audio.js status           how much of each course is recorded
 *
 * Clips live at assets/audio/<lang>/<item-id>.mp3 and the app plays one in
 * place of the system voice whenever it exists, so a course can sound the same
 * for everyone instead of depending on what each machine has installed.
 *
 * A "build the sentence" exercise cuts a phrase into tiles, and a tile is
 * almost never an item: of the 97 chunks in the French course, 11 are words
 * the course teaches on their own and the other 86 exist only as pieces. Tap
 * one and there is nothing to play unless the machine happens to have a French
 * voice, which most do not. So the pieces are recorded too, under
 * assets/audio/<lang>/w/<slug>.mp3, and the manifest carries the word each
 * file belongs to -- written as it appears, lowercased -- because a slug has
 * to be ASCII and two different words can flatten onto the same one.
 *
 * To record a language, send the TSV through whatever text-to-speech you like,
 * save each row as <id>.mp3 under assets/audio/<lang>/, then run `manifest`.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const PAGE = path.join(ROOT, "index.html");
const AUDIO = path.join(ROOT, "assets", "audio");
/* Whatever the chosen text-to-speech produced. One format per manifest: the
   app builds the clip URL from it, so a folder cannot mix them. */
const FORMATS = ["mp3", "m4a", "ogg", "opus", "wav"];

/* The courses live inside the page, so the page is where they are read from.
   const and let never land on the global object, hence the export line. */
function courses() {
  const html = fs.readFileSync(PAGE, "utf8");
  const open = html.indexOf("<script>");
  const close = html.lastIndexOf("</script>");
  const src = html.slice(open + "<script>".length, close);
  const cut = src.indexOf("/* ============================== STATE");
  const sandbox = { console: console };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src.slice(0, cut) + ";globalThis.__c = { COURSES: COURSES, LANGS: LANGS };", ctx);
  return sandbox.__c;
}

/* The page's own splitter, which keeps the case and the accents and drops
   only the punctuation hanging off the ends. Copied rather than imported:
   this reads the courses out of the page above the STATE line, and `words`
   lives below it. A test holds the two together. */
function chunks(text) {
  return String(text).split(/\s+/)
    .map(function (w) { return w.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, ""); })
    .filter(Boolean);
}

/* Two spellings of one word -- "ça" at the front of a sentence and "ça" in the
   middle -- are one recording. Accents stay in the key, so "esta" and "está"
   do not become one. */
function key(word) {
  return String(word).toLowerCase().replace(/[\u2018\u2019\u02bc]/g, "'");
}

/* The file name: ASCII, because a URL built from a filename with a macron in
   it is a different kind of trouble on every filesystem it meets. Distinct
   words that land on the same slug get a number, which is why the manifest
   holds the map rather than the app working it out. */
/* Windows keeps a handful of names for devices -- CON, PRN, AUX, NUL and the
   COM and LPT ports -- and will not let a file be called con.mp3. Writing one
   opens the device instead, succeeds, and leaves nothing on disk, so the clip
   for Spanish "con" went missing without a word of complaint. The file is
   renamed rather than the word, which the manifest maps back anyway. */
const DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

function slugs(keys) {
  const taken = {}, out = {};
  keys.slice().sort().forEach(function (k, i) {
    let base = k.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/['\s]+/g, "-").replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-").replace(/^-|-$/g, "");
    if (!base) base = "w" + i;
    if (DEVICE.test(base)) base = base + "-w";
    let name = base, n = 1;
    while (taken[name]) name = base + "-" + (++n);
    taken[name] = true;
    out[k] = name;
  });
  return out;
}

/* Every chunk a tile can show in one course: the parts of each phrase, which
   are also the distractors drawn from the other phrases. */
function wordsOf(course) {
  const seen = {};
  course.items.forEach(function (it) {
    if (it.kind !== "p") return;
    (it.bank ? it.bank : chunks(it.tgt)).forEach(function (w) {
      const k = key(w);
      if (k) seen[k] = true;
    });
  });
  return Object.keys(seen);
}

function rows(only) {
  const c = courses();
  const out = [];
  c.LANGS.forEach(function (lg) {
    if (only && lg !== only) return;
    const course = c.COURSES[lg];
    course.items.forEach(function (it) {
      out.push({ id: it.id, lang: course.tts, text: it.tgt, en: it.en });
    });
  });
  return out;
}

function listed(lang) {
  const dir = path.join(AUDIO, lang);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(function (f) {
    return FORMATS.indexOf(path.extname(f).slice(1).toLowerCase()) > -1;
  });
}

function formatOf(files) {
  const seen = [...new Set(files.map(function (f) {
    return path.extname(f).slice(1).toLowerCase();
  }))];
  if (seen.length > 1) {
    console.error("mixed formats under assets/audio: " + seen.join(", ") +
      " — the app builds one URL per manifest, so pick one");
    process.exit(1);
  }
  return seen[0] || FORMATS[0];
}

function cmdList(only) {
  const all = rows(only);
  if (!all.length) {
    console.error(only ? "no such course: " + only : "no courses found");
    process.exit(1);
  }
  console.log(["id", "lang", "text"].join("\t"));
  all.forEach(function (r) {
    /* Tabs and newlines would break the row; neither belongs in a phrase. */
    console.log([r.id, r.lang, r.text.replace(/\s+/g, " ")].join("\t"));
  });
}

function cmdWords(only) {
  const c = courses();
  const found = [];
  c.LANGS.forEach(function (lg) {
    if (only && lg !== only) return;
    const course = c.COURSES[lg];
    const keys = wordsOf(course);
    const name = slugs(keys);
    keys.sort().forEach(function (k) {
      found.push({ id: "w/" + name[k], lang: course.tts, text: k });
    });
  });
  if (!found.length) {
    console.error(only ? "no such course: " + only : "no courses found");
    process.exit(1);
  }
  console.log(["id", "lang", "text"].join("\t"));
  found.forEach(function (r) {
    console.log([r.id, r.lang, r.text.replace(/\s+/g, " ")].join("\t"));
  });
}

function cmdManifest() {
  const c = courses();
  const known = {};
  c.LANGS.forEach(function (lg) {
    c.COURSES[lg].items.forEach(function (it) { known[it.id] = lg; });
  });

  const files = [];
  c.LANGS.forEach(function (lg) {
    listed(lg).forEach(function (f) { files.push(lg + "/" + f); });
  });

  /* The word clips, which are keyed by the word rather than by a file name:
     the app looks up what is on the tile, lowercased, and gets back the slug
     the recording was written under. */
  const words = {};
  const wordFiles = [];
  c.LANGS.forEach(function (lg) {
    const keys = wordsOf(c.COURSES[lg]);
    const name = slugs(keys);
    const here = listed(path.join(lg, "w"));
    const have = {};
    here.forEach(function (f) { have[path.basename(f, path.extname(f))] = true; });
    here.forEach(function (f) { wordFiles.push(lg + "/w/" + f); });
    const mine = {};
    keys.sort().forEach(function (k) { if (have[name[k]]) mine[k] = name[k]; });
    if (Object.keys(mine).length) words[lg] = mine;
  });
  const format = formatOf(files.concat(wordFiles));

  const items = [];
  const strays = [];
  files.forEach(function (rel) {
    const lg = rel.split("/")[0];
    const id = path.basename(rel, path.extname(rel));
    if (known[id] === lg) items.push(id);
    else strays.push(rel);
  });
  items.sort();

  if (!fs.existsSync(AUDIO)) fs.mkdirSync(AUDIO, { recursive: true });
  const file = path.join(AUDIO, "index.json");
  if (!items.length) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    console.log("no clips found; removed the manifest so the app falls back to the voice");
  } else {
    const body = { format: format, items: items };
    const spoken = Object.keys(words).reduce(function (n, lg) {
      return n + Object.keys(words[lg]).length;
    }, 0);
    if (spoken) body.words = words;
    fs.writeFileSync(file, JSON.stringify(body, null, 0) + "\n");
    console.log("wrote " + path.relative(ROOT, file) + " with " + items.length + " ." + format
      + " clips" + (spoken ? " and " + spoken + " tile words" : ""));
  }
  strays.forEach(function (f) {
    console.log("  ignored, no item has that id: " + f);
  });
  cmdStatus();
}

function cmdStatus() {
  const c = courses();
  c.LANGS.forEach(function (lg) {
    const have = {};
    listed(lg).forEach(function (f) { have[path.basename(f, path.extname(f))] = true; });
    const items = c.COURSES[lg].items;
    const n = items.filter(function (it) { return have[it.id]; }).length;
    const keys = wordsOf(c.COURSES[lg]);
    const name = slugs(keys);
    const got = {};
    listed(path.join(lg, "w")).forEach(function (f) { got[path.basename(f, path.extname(f))] = true; });
    const w = keys.filter(function (k) { return got[name[k]]; }).length;
    console.log("  " + c.COURSES[lg].name.padEnd(9) + n + " of " + items.length +
      (n === items.length ? "  complete" : n ? "  partial, the rest falls back to the voice" : "") +
      "   tiles: " + w + " of " + keys.length);
  });
}

const cmd = process.argv[2];
if (cmd === "list") cmdList(process.argv[3]);
else if (cmd === "words") cmdWords(process.argv[3]);
else if (cmd === "manifest") cmdManifest();
else if (cmd === "status") cmdStatus();
else {
  console.log("usage: node tools/audio.js list [lang] | words [lang] | manifest | status");
  process.exit(cmd ? 1 : 0);
}
