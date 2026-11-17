/*
 * Tests for the sync worker: `node test.js` from this folder. No dependencies
 * and nothing deployed -- the worker is a plain fetch handler, so it is called
 * directly with a Request and a stand-in for D1.
 *
 * What is worth testing here is the part that fails quietly. A worker that
 * hands one person's progress to another, or that takes a write it should have
 * refused, looks perfectly healthy from the outside.
 */

import assert from "node:assert";
import worker from "./worker.js";

/* Enough of D1 to answer the two statements the worker sends. */
function makeDb() {
  const rows = new Map();
  return {
    rows: rows,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              const row = rows.get(args[0]);
              return row ? { blob: row.blob, at: row.at } : null;
            },
            async run() {
              assert.ok(/INSERT INTO slots/.test(sql), "the only write is the upsert");
              rows.set(args[0], { blob: args[1], at: args[2] });
              return { success: true };
            }
          };
        }
      };
    }
  };
}

const CODE = "abcd-1234-wxyz";
const call = (db, method, path, body) =>
  worker.fetch(new Request("https://sync.example" + path, {
    method: method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : body
  }), { DB: db });

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(true);
    console.log("  ok   " + name);
  } catch (e) {
    results.push(false);
    console.log("  FAIL " + name + "\n       " + (e && e.message));
  }
}

await test("a code nobody has written to is empty, not an error", async () => {
  const r = await call(makeDb(), "GET", "/v1/" + CODE);
  assert.strictEqual(r.status, 404);
  /* The app reads this as "I am the first device here" and writes its own
     progress, rather than as a failure worth showing anyone. */
  assert.deepStrictEqual(await r.json(), { error: "nothing here" });
});

await test("what goes in comes back exactly", async () => {
  const db = makeDb();
  const state = { active: "fr", streak: 3, courses: { fr: { xp: 40, srs: { "fr-0-1": { box: 2 } } } } };
  const put = await call(db, "PUT", "/v1/" + CODE, JSON.stringify({ state: state }));
  assert.strictEqual(put.status, 200);
  const at = (await put.json()).at;
  assert.ok(at > 0, "the write is stamped");

  const got = await call(db, "GET", "/v1/" + CODE).then((r) => r.json());
  assert.deepStrictEqual(got.state, state, "nested and whole");
  assert.strictEqual(got.at, at);
});

await test("a second write replaces the first", async () => {
  const db = makeDb();
  await call(db, "PUT", "/v1/" + CODE, JSON.stringify({ state: { streak: 1 } }));
  await call(db, "PUT", "/v1/" + CODE, JSON.stringify({ state: { streak: 9 } }));
  const got = await call(db, "GET", "/v1/" + CODE).then((r) => r.json());
  assert.deepStrictEqual(got.state, { streak: 9 });
  assert.strictEqual(db.rows.size, 1, "and does not leave the old one behind");
});

await test("two codes never see each other", async () => {
  const db = makeDb();
  await call(db, "PUT", "/v1/" + CODE, JSON.stringify({ state: { mine: true } }));
  const other = await call(db, "GET", "/v1/0000-0000-0000");
  assert.strictEqual(other.status, 404, "a code is the only thing standing between two people");
});

await test("a code that is not a code is refused", async () => {
  const db = makeDb();
  for (const bad of ["abcd-1234", "abcd-1234-wxyz-0000", "abcd1234wxyz",
                     "abcd-1234-wxy!", "abcd-1234-wxyi", "abcd-1234-wxyu"]) {
    const r = await call(db, "PUT", "/v1/" + bad, JSON.stringify({ state: {} }));
    assert.strictEqual(r.status, 400, bad + " should not be accepted");
  }
  /* i, l, o and u are not in the alphabet the app draws from, so a code
     carrying one was mistyped rather than merely unlucky. */
  assert.strictEqual(db.rows.size, 0, "and nothing was written");
});

await test("a code shouted in capitals is the same code", async () => {
  const db = makeDb();
  await call(db, "PUT", "/v1/" + CODE, JSON.stringify({ state: { x: 1 } }));
  const r = await call(db, "GET", "/v1/" + CODE.toUpperCase());
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual((await r.json()).state, { x: 1 });
});

await test("a body that is not a state is refused", async () => {
  const db = makeDb();
  assert.strictEqual((await call(db, "PUT", "/v1/" + CODE, "not json at all")).status, 400);
  assert.strictEqual((await call(db, "PUT", "/v1/" + CODE, '{"state":null}')).status, 400);
  assert.strictEqual((await call(db, "PUT", "/v1/" + CODE, '{"state":"hello"}')).status, 400);
  assert.strictEqual((await call(db, "PUT", "/v1/" + CODE, '{"nope":{}}')).status, 400);
  assert.strictEqual(db.rows.size, 0);
});

await test("nobody parks a film in here", async () => {
  const db = makeDb();
  const huge = JSON.stringify({ state: { pad: "x".repeat(300 * 1024) } });
  const r = await call(db, "PUT", "/v1/" + CODE, huge);
  assert.strictEqual(r.status, 413);
  assert.strictEqual(db.rows.size, 0);
});

await test("only the two methods the app uses are answered", async () => {
  const db = makeDb();
  for (const m of ["DELETE", "POST", "PATCH"]) {
    assert.strictEqual((await call(db, m, "/v1/" + CODE, "{}")).status, 405, m);
  }
});

await test("a browser asking first is told it may", async () => {
  const r = await call(makeDb(), "OPTIONS", "/v1/" + CODE);
  assert.strictEqual(r.status, 204);
  assert.strictEqual(r.headers.get("access-control-allow-origin"), "*");
  assert.ok(r.headers.get("access-control-allow-methods").includes("PUT"));
});

await test("every answer carries the headers a page needs to read it", async () => {
  const db = makeDb();
  await call(db, "PUT", "/v1/" + CODE, JSON.stringify({ state: {} }));
  for (const r of [await call(db, "GET", "/v1/" + CODE),
                   await call(db, "GET", "/v1/0000-0000-0000"),
                   await call(db, "PUT", "/v1/" + CODE, JSON.stringify({ state: {} }))]) {
    assert.strictEqual(r.headers.get("access-control-allow-origin"), "*");
    assert.strictEqual(r.headers.get("cache-control"), "no-store",
      "a cached answer would hand back progress that has already moved on");
  }
});

await test("anything that is not the one path is nothing", async () => {
  const db = makeDb();
  for (const path of ["/", "/v1", "/v1/" + CODE + "/extra", "/v2/" + CODE, "/admin"]) {
    assert.strictEqual((await call(db, "GET", path)).status, 404, path);
  }
});

const failed = results.filter((r) => !r).length;
console.log("\n" + (results.length - failed) + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
