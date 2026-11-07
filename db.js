const { Pool } = require('pg');

const url = process.env.DATABASE_URL || '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);

const pool = new Pool({
  connectionString: url,
  // Neon (and any hosted Postgres) needs SSL; a local Docker Postgres doesn't.
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 5,
  // Keep connections open between requests: opening a new one (TLS + auth) costs several round trips.
  idleTimeoutMillis: 5 * 60 * 1000,
  keepAlive: true,
});

// Neon closes idle connections; don't let that crash the process.
pool.on('error', (err) => console.error('Postgres pool error:', err.message));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_name_lower_idx ON users (lower(name));

CREATE TABLE IF NOT EXISTS items (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  start_price  INTEGER NOT NULL DEFAULT 0,          -- cents, 0 = free
  status       TEXT NOT NULL DEFAULT 'available',   -- available | reserved | gone
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Photos for an item. The lowest position is the cover shown on the homepage.
-- Image rows are never modified, so /img/:id can be cached forever.
CREATE TABLE IF NOT EXISTS images (
  id          SERIAL PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  data        BYTEA NOT NULL,                       -- always JPEG (resized on upload)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS images_item_idx ON images (item_id, position);

CREATE TABLE IF NOT EXISTS bids (
  id          SERIAL PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount      INTEGER NOT NULL,                     -- cents
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bids_item_idx ON bids (item_id);

-- accepted: counts (at/above asking price, or approved by the owner)
-- pending:  an offer below the asking price, waiting for the owner
-- rejected: turned down by the owner, no longer counts
-- Added with ALTER so existing databases keep their data (existing bids were all valid = accepted).
ALTER TABLE bids ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'accepted';
`;

async function init() {
  await pool.query(SCHEMA);
}

// Run fn(client) inside a transaction; rolls back on any thrown error.
async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, init, withTx };
