'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const db = new DatabaseSync(path.join(config.dataDir, 'app.db'));

// All timestamps are integer milliseconds since the Unix epoch.
db.exec(`
  PRAGMA journal_mode = WAL;

  -- People who sign in to the dashboard.
  CREATE TABLE IF NOT EXISTS users (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    username          TEXT NOT NULL,
    username_key      TEXT NOT NULL UNIQUE,              -- lower case, used for lookups
    password_hash     TEXT NOT NULL,
    role              TEXT NOT NULL DEFAULT 'staff',     -- admin | staff | customer
    status            TEXT NOT NULL DEFAULT 'pending',   -- pending | active | disabled
    created_at        INTEGER NOT NULL,
    last_login_at     INTEGER
  );

  -- Delivery partners. The token is what the phone app signs in with.
  CREATE TABLE IF NOT EXISTS drivers (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    token             TEXT NOT NULL UNIQUE,
    disabled          INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL,
    last_seen_at      INTEGER
  );

  -- Helmet cameras. The secret signs every upload.
  CREATE TABLE IF NOT EXISTS devices (
    id                TEXT PRIMARY KEY,
    label             TEXT NOT NULL DEFAULT '',
    secret            TEXT NOT NULL,
    disabled          INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL,
    last_seen_at      INTEGER
  );

  CREATE TABLE IF NOT EXISTS deliveries (
    id                TEXT PRIMARY KEY,
    customer_name     TEXT NOT NULL,
    address           TEXT NOT NULL,
    dest_lat          REAL NOT NULL,
    dest_lon          REAL NOT NULL,
    driver_id         TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'assigned',  -- assigned | in_progress | delivered | failed
    attempts          INTEGER NOT NULL DEFAULT 0,
    proof_recording   TEXT,
    completed_lat     REAL,
    completed_lon     REAL,
    fail_reason       TEXT,
    created_at        INTEGER NOT NULL,
    delivered_at      INTEGER
  );

  -- One row per recording attempt. id is "<deliveryId>-<attempt>".
  CREATE TABLE IF NOT EXISTS recordings (
    id                TEXT PRIMARY KEY,
    delivery_id       TEXT NOT NULL,
    attempt           INTEGER NOT NULL,
    device_id         TEXT,
    status            TEXT NOT NULL DEFAULT 'receiving', -- receiving | complete | interrupted | purged | expired
    expected_chunks   INTEGER,
    flags             INTEGER NOT NULL DEFAULT 0,
    started_at        INTEGER NOT NULL,
    completed_at      INTEGER
  );
  CREATE INDEX IF NOT EXISTS recordings_delivery ON recordings (delivery_id);

  CREATE TABLE IF NOT EXISTS chunks (
    recording_id      TEXT NOT NULL,
    idx               INTEGER NOT NULL,
    sha256            TEXT NOT NULL,
    bytes             INTEGER NOT NULL,
    frames            INTEGER NOT NULL,
    duration_ms       INTEGER NOT NULL,
    start_epoch       INTEGER NOT NULL,
    flags             INTEGER NOT NULL,
    received_at       INTEGER NOT NULL,
    PRIMARY KEY (recording_id, idx)
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_id       TEXT NOT NULL,
    raised_by         TEXT NOT NULL,                     -- customer | driver | staff
    reason            TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'open',      -- open | resolved
    resolution        TEXT,
    created_at        INTEGER NOT NULL,
    resolved_at       INTEGER
  );
  CREATE INDEX IF NOT EXISTS tickets_delivery ON tickets (delivery_id);

  -- Live locations. A rider's position comes from their phone; a customer's
  -- only when they choose to share it from their tracking link.
  CREATE TABLE IF NOT EXISTS positions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    subject           TEXT NOT NULL,                     -- driver | customer
    subject_id        TEXT NOT NULL,                     -- driver id, or delivery id for a customer
    delivery_id       TEXT,                              -- the delivery under way at the time
    lat               REAL NOT NULL,
    lon               REAL NOT NULL,
    accuracy          REAL,                              -- metres
    speed             REAL,                              -- metres per second
    heading           REAL,                              -- degrees from north
    at                INTEGER NOT NULL                   -- server time it arrived
  );
  CREATE INDEX IF NOT EXISTS positions_subject ON positions (subject, subject_id, at);
  CREATE INDEX IF NOT EXISTS positions_delivery ON positions (delivery_id, at);

  -- Audit trail: everything the helmet, phone, staff, or server did.
  CREATE TABLE IF NOT EXISTS events (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_id       TEXT,
    recording_id      TEXT,
    source            TEXT NOT NULL,                     -- device | driver | staff | system
    type              TEXT NOT NULL,
    detail            TEXT,
    actor             TEXT,                              -- username, for staff actions
    at                INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_delivery ON events (delivery_id);
`);

// ---- Upgrades for databases created by earlier versions ------------------------

const hasColumn = (table, name) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === name);

if (!hasColumn('events', 'actor')) db.exec('ALTER TABLE events ADD COLUMN actor TEXT');

// Each delivery gets a secret tracking link for its customer.
// A delivery can be linked to a customer account, so that customer can sign in and follow it.
if (!hasColumn('deliveries', 'customer_user_id')) db.exec('ALTER TABLE deliveries ADD COLUMN customer_user_id INTEGER');
db.exec('CREATE INDEX IF NOT EXISTS deliveries_customer ON deliveries (customer_user_id)');

if (!hasColumn('deliveries', 'track_token')) db.exec('ALTER TABLE deliveries ADD COLUMN track_token TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS deliveries_track_token ON deliveries (track_token)');
for (const row of db.prepare('SELECT id FROM deliveries WHERE track_token IS NULL').all()) {
  db.prepare('UPDATE deliveries SET track_token = ? WHERE id = ?').run(newTrackToken(), row.id);
}

/** A random, unguessable token for a customer tracking link. */
function newTrackToken() {
  return crypto.randomBytes(18).toString('base64url');
}

const cache = new Map();
function statement(sql) {
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}

const one = (sql, ...params) => statement(sql).get(...params);
const all = (sql, ...params) => statement(sql).all(...params);
const run = (sql, ...params) => statement(sql).run(...params);

function logEvent({
  deliveryId = null, recordingId = null, source, type, detail = null, actor = null, at = Date.now(),
}) {
  run(
    'INSERT INTO events (delivery_id, recording_id, source, type, detail, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    deliveryId, recordingId, source, type, detail, actor, at,
  );
}

module.exports = { db, one, all, run, logEvent, newTrackToken };
