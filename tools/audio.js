/*
 * Recorded audio for Linguae. No dependencies.
 *
 *   node tools/audio.js list [lang]      what to record, as TSV: id, BCP-47 tag, text
 *   node tools/audio.js manifest         scan assets/audio and write its index.json
 *   node tools/audio.js status           how much of each course is recorded
 *
 * Clips live at assets/audio/<lang>/<item-id>.mp3 and the app plays one in
 * place of the system voice whenever it exists, so a course can sound the same
 * for everyone instead of depending on what each machine has installed.
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
  const format = formatOf(files);

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
    fs.writeFileSync(file, JSON.stringify({ format: format, items: items }, null, 0) + "\n");
    console.log("wrote " + path.relative(ROOT, file) + " with " + items.length + " ." + format + " clips");
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
    console.log("  " + c.COURSES[lg].name.padEnd(9) + n + " of " + items.length +
      (n === items.length ? "  complete" : n ? "  partial, the rest falls back to the voice" : ""));
  });
}

const cmd = process.argv[2];
if (cmd === "list") cmdList(process.argv[3]);
else if (cmd === "manifest") cmdManifest();
else if (cmd === "status") cmdStatus();
else {
  console.log("usage: node tools/audio.js list [lang] | manifest | status");
  process.exit(cmd ? 1 : 0);
}
