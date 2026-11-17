# Carrying your progress to another device

Linguae keeps your progress in the browser, and that does not travel. This
folder is the smallest thing that makes it travel: one Cloudflare Worker and
one table, holding a single blob of JSON per code.

**It is already deployed**, at the address in `SYNC_HOME` near the top of the
sync section in `index.html`. Nothing below is needed unless you are running
your own copy of Linguae, or moving this one to another account.

It costs nothing and there is no card to give. Cloudflare's free plan allows
100,000 worker requests a day, and D1 allows 5 million row reads and 100,000
row writes a day against 5 GB of storage. One person syncing a few times a day
uses a rounding error of that. Unlike a free database elsewhere, it is **not
paused for going a week unused** — which is exactly when you would come back to
it.

## There is no account, and the code is the lock

A device makes a twelve-character code and the other device is told it. That
code is the key to the stored copy: anyone holding it can read and write your
progress, and there is no password on top. Twelve characters out of a
thirty-two letter alphabet is sixty bits, far past guessing, but it is worth
knowing that it is the whole of the lock. What is stored is which words you
have met and when they are due — no name, no email, nothing to identify you.

The server never looks inside the blob, so changing a course, adding a language
or reshaping the state needs nothing redeployed here.

The address *is* public — it has to be, it is in the page. Nobody can reach a
code they do not have, but they could write junk under codes of their own until
the day's quota was gone, so every request is counted against the address it
came from: 20 a minute, where two devices send about two. Cloudflare counts
this loosely on purpose, and it shows — a limit set at 100 let 360 requests
through untouched, while at 20 a flood was turned away after 25. That is the
reason the number is well under what looks reasonable rather than well over.

## Setting it up, once

You need [Node](https://nodejs.org) and a free account at
[dash.cloudflare.com](https://dash.cloudflare.com). From **this folder**:

```bash
npx wrangler login
```

```bash
npx wrangler d1 create linguae-sync
```

That prints a `database_id`. Put it in `wrangler.toml`, replacing
`paste-the-id-wrangler-prints-here`. Then make the table:

```bash
npx wrangler d1 execute linguae-sync --remote --file=./schema.sql
```

And put the worker up:

```bash
npx wrangler deploy
```

The last command prints the address, something like
`https://linguae-sync.yourname.workers.dev`. That is all the app needs.

## Turning it on in Linguae

1. Open **Progress → Your devices** and tap **Create a code**. It syncs at once.
2. On the other device, open the same panel and type the code into *Already
   have one from another device?*

A device that has never been used shows the same panel on the course picker,
since someone arriving on their phone has already chosen a course — over on the
other device, where the code is. The course comes across with everything else.

The address is already in the page, so neither device is ever asked for one.
Clearing it in `SYNC_HOME` brings the address field back, which is how a device
is pointed at a different server.

From then on it syncs when the app opens and when a lesson ends. With no
network it does nothing and says so; the lesson works exactly as before and
goes across next time.

## Checking it

```bash
node test.js
```

Thirteen tests, no dependencies and nothing deployed: the worker is a plain
fetch handler, so the tests call it directly with stand-ins for D1 and the rate
limiter. They cover the parts that fail quietly — a code handing back someone
else's progress, a write that should have been refused, a cached answer serving
progress that has already moved on.

## The shape of it

```
GET  /v1/<code>   ->  { state, at }     404 when nothing is stored yet
PUT  /v1/<code>   <-  { state }         ->  { at }
```

The app always reads before it writes and merges the two, so a device that has
been offline for a week adds what it learnt instead of flattening what the
other one did. The merge rules are in `index.html`, next to the code that runs
them.
