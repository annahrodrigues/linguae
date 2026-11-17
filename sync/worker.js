/*
 * The whole server behind Linguae's sync: one JSON blob per code.
 *
 *   GET  /v1/<code>   ->  { state, at }     404 if nothing is stored yet
 *   PUT  /v1/<code>   <-  { state }         -> { at }
 *
 * It knows nothing about lessons, words or people. A code is twelve random
 * characters made on a device, and whoever holds it can read and write that
 * one row -- which is the whole of the lock, and is said plainly in the app.
 * There is no account to break into because there is no account.
 *
 * The address is in the page, so anyone can reach this. Nobody can reach a
 * code they do not have, but they could write junk under codes of their own
 * and fill the free quota, so every request is counted against its address
 * first. A person syncing two devices sends a handful a day.
 *
 * Deployed on Cloudflare's free plan, where it costs nothing and, unlike a
 * free database elsewhere, is not paused for going a week unused.
 * sync/README.md has the five commands.
 */

const CODE = /^[0-9abcdefghjkmnpqrstvwxyz]{4}-[0-9abcdefghjkmnpqrstvwxyz]{4}-[0-9abcdefghjkmnpqrstvwxyz]{4}$/;

/* A whole course history is a few tens of kilobytes. This is room enough for
   every course at once and still small enough that nobody can park a film in
   here. */
const MAX = 256 * 1024;

const CORS = {
  /* Anyone may ask, because asking is useless without the code: there are no
     cookies and no session to ride on. Narrowing this to one site would stop
     nothing that is not already stopped. */
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, PUT, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400"
};

function reply(body, status) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ "content-type": "application/json; charset=utf-8",
                             "cache-control": "no-store" }, CORS)
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const path = new URL(request.url).pathname;
    const at = path.match(/^\/v1\/([^/]+)$/);
    if (!at) return reply({ error: "not found" }, 404);

    const code = at[1].toLowerCase();
    if (!CODE.test(code)) return reply({ error: "bad code" }, 400);

    /* Counted per address, not per code: a flood would use a fresh code every
       time, which is exactly what counting by code would miss. The number is
       in wrangler.toml, and is not a copy of it here where the two could
       drift apart -- 20 a minute, where two devices send about two and a
       flood was measured being turned away after 25. Cloudflare counts this
       loosely on purpose, so a limit set at what one person needs would let a
       burst through before it noticed. */
    const who = request.headers.get("cf-connecting-ip") || "unknown";
    const allowed = await env.LIMIT.limit({ key: who });
    if (!allowed.success) return reply({ error: "too many requests" }, 429);

    if (request.method === "GET") {
      const row = await env.DB.prepare("SELECT blob, at FROM slots WHERE code = ?")
        .bind(code).first();
      if (!row) return reply({ error: "nothing here" }, 404);
      /* The blob goes back as it came in: this end never reads inside it, so
         a change to what a course looks like needs nothing deployed here. */
      return new Response('{"state":' + row.blob + ',"at":' + row.at + "}", {
        headers: Object.assign({ "content-type": "application/json; charset=utf-8",
                                 "cache-control": "no-store" }, CORS)
      });
    }

    if (request.method === "PUT") {
      const text = await request.text();
      if (text.length > MAX) return reply({ error: "too large" }, 413);
      let sent;
      try { sent = JSON.parse(text); } catch (e) { return reply({ error: "not json" }, 400); }
      if (!sent || typeof sent.state !== "object" || sent.state === null) {
        return reply({ error: "no state" }, 400);
      }
      const now = Date.now();
      await env.DB.prepare(
        "INSERT INTO slots (code, blob, at) VALUES (?, ?, ?) " +
        "ON CONFLICT(code) DO UPDATE SET blob = excluded.blob, at = excluded.at"
      ).bind(code, JSON.stringify(sent.state), now).run();
      return reply({ at: now });
    }

    return reply({ error: "method not allowed" }, 405);
  }
};
