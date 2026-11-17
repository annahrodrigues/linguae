# Carrying your progress to another device

Linguae keeps your progress in the browser, and that does not travel. This
folder is the smallest thing that makes it travel: one Cloudflare Worker and
one table, holding a single blob of JSON per code.

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

1. Open **Progress → Your devices**, paste the address, save it.
2. Tap **Create a code**. It syncs straight away.
3. On the other device, open the same panel, paste the same address, and type
   the code into *Already have one from another device?*

From then on it syncs when the app opens and when a lesson ends. With no
network it does nothing and says so; the lesson works exactly as before and
goes across next time.

Once you know your address it is worth putting into `SYNC_HOME` at the top of
the sync section in `index.html`, so a new device only ever needs the code.

## Checking it

```bash
node test.js
```

Twelve tests, no dependencies and nothing deployed: the worker is a plain fetch
handler, so the tests call it directly with a stand-in for D1. They cover the
parts that fail quietly — a code handing back someone else's progress, a write
that should have been refused, a cached answer serving progress that has
already moved on.

## The shape of it

```
GET  /v1/<code>   ->  { state, at }     404 when nothing is stored yet
PUT  /v1/<code>   <-  { state }         ->  { at }
```

The app always reads before it writes and merges the two, so a device that has
been offline for a week adds what it learnt instead of flattening what the
other one did. The merge rules are in `index.html`, next to the code that runs
them.
