-- One row per sync code. The blob is the app's own state, untouched: this end
-- never reads inside it, so the course format can change without a deploy.
CREATE TABLE IF NOT EXISTS slots (
  code TEXT PRIMARY KEY,
  blob TEXT NOT NULL,
  at   INTEGER NOT NULL
);
