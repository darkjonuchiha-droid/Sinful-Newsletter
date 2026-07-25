'use strict';
// Storage abstraction with two drivers, chosen by environment:
//   - DATABASE_URL set   -> Postgres (Neon, Supabase, local pg, ...)
//   - otherwise          -> embedded SQLite via node:sqlite (self-hosted)
//
// Portability rules used by all queries in this codebase:
//   - placeholders are `?` (converted to $n for Postgres here)
//   - timestamps are ISO-8601 UTC strings supplied from JS (db.now()),
//     stored in TEXT columns -> identical behavior in both engines
//   - case-insensitive matching uses LOWER(), never COLLATE NOCASE
//   - no engine-specific SQL functions in query strings

const config = require('./config');

const NOW = () => new Date().toISOString();

function schemaSql(kind) {
  const id = kind === 'pg' ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  return [
    `CREATE TABLE IF NOT EXISTS subscribers (
      uuid         TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      active       INTEGER NOT NULL DEFAULT 1,
      shadowbanned INTEGER NOT NULL DEFAULT 0,
      source       TEXT NOT NULL DEFAULT 'admin',
      created_at   TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS packages (
      id          ${id},
      name        TEXT NOT NULL,
      message     TEXT NOT NULL DEFAULT '',
      items       TEXT NOT NULL DEFAULT '[]',
      only_online INTEGER NOT NULL DEFAULT 0,
      is_public   INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS deliveries (
      id         ${id},
      package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
      uuid       TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'queued',
      queued_at  TEXT NOT NULL,
      claimed_at TEXT,
      sent_at    TEXT)`,
    `CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries(status)`,
    `CREATE INDEX IF NOT EXISTS idx_deliveries_pkg ON deliveries(package_id, status)`,
    `CREATE TABLE IF NOT EXISTS lookups (
      id         ${id},
      kind       TEXT NOT NULL,
      query      TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS kiosk (
      id        INTEGER PRIMARY KEY,
      url       TEXT,
      last_seen TEXT,
      inventory TEXT NOT NULL DEFAULT '[]')`,
    `INSERT INTO kiosk (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,
    `CREATE TABLE IF NOT EXISTS satellites (
      object_key TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      region     TEXT NOT NULL DEFAULT '',
      list_name  TEXT NOT NULL DEFAULT '',
      last_seen  TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS login_attempts (
      ip    TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      last  TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS lists (
      id         ${id},
      name       TEXT NOT NULL,
      created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS list_members (
      list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      uuid    TEXT NOT NULL REFERENCES subscribers(uuid) ON DELETE CASCADE,
      PRIMARY KEY (list_id, uuid))`,
    `CREATE TABLE IF NOT EXISTS schedules (
      id         ${id},
      package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
      send_at    TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      fired_at   TEXT)`,
    `CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(status, send_at)`,
  ];
}

async function initSqlite() {
  const fs = require('node:fs');
  const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const db = new DatabaseSync(config.dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA wal_autocheckpoint = 1000');
  db.exec('PRAGMA foreign_keys = ON');
  for (const s of schemaSql('sqlite')) db.exec(s);
  // migrations (added after 2.0; sqlite lacks ADD COLUMN IF NOT EXISTS)
  try { db.exec('ALTER TABLE schedules ADD COLUMN list_id INTEGER'); } catch (e) { /* exists */ }
  try { db.exec('ALTER TABLE subscribers ADD COLUMN shadowbanned INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* exists */ }
  try { db.exec('ALTER TABLE packages ADD COLUMN only_online INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* exists */ }
  // deliveries.list_id: 0 = send-to-all blast, >0 = that list, NULL = individual
  try { db.exec('ALTER TABLE deliveries ADD COLUMN list_id INTEGER'); } catch (e) { /* exists */ }
  // deliveries.only_online: per-send override; NULL = use the package's flag
  try { db.exec('ALTER TABLE deliveries ADD COLUMN only_online INTEGER'); } catch (e) { /* exists */ }
  try { db.exec("ALTER TABLE subscribers ADD COLUMN display_name TEXT NOT NULL DEFAULT ''"); } catch (e) { /* exists */ }
  try { db.exec('ALTER TABLE packages ADD COLUMN is_public INTEGER NOT NULL DEFAULT 1'); } catch (e) { /* exists */ }
  return {
    kind: 'sqlite',
    async all(sql, p = []) { return db.prepare(sql).all(...p); },
    async get(sql, p = []) { return db.prepare(sql).get(...p); },
    async run(sql, p = []) { return { changes: db.prepare(sql).run(...p).changes }; },
    async insert(sql, p = []) { return Number(db.prepare(sql).run(...p).lastInsertRowid); },
  };
}

async function initPg() {
  const { Pool, types } = require('pg');
  // COUNT()/SUM() come back as int8 -> parse to JS numbers (values here are tiny).
  types.setTypeParser(20, v => parseInt(v, 10));
  const pool = new Pool({ connectionString: config.databaseUrl, max: 3 });
  for (const s of schemaSql('pg')) await pool.query(s);
  await pool.query('ALTER TABLE schedules ADD COLUMN IF NOT EXISTS list_id INTEGER');
  await pool.query('ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS shadowbanned INTEGER NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE packages ADD COLUMN IF NOT EXISTS only_online INTEGER NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS list_id INTEGER');
  await pool.query('ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS only_online INTEGER');
  await pool.query("ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT ''");
  await pool.query('ALTER TABLE packages ADD COLUMN IF NOT EXISTS is_public INTEGER NOT NULL DEFAULT 1');
  const conv = (sql) => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); };
  return {
    kind: 'pg',
    async all(sql, p = []) { return (await pool.query(conv(sql), p)).rows; },
    async get(sql, p = []) { return (await pool.query(conv(sql), p)).rows[0]; },
    async run(sql, p = []) { return { changes: (await pool.query(conv(sql), p)).rowCount }; },
    async insert(sql, p = []) {
      return (await pool.query(conv(sql) + ' RETURNING id', p)).rows[0].id;
    },
  };
}

let impl = null;
const ready = (config.databaseUrl ? initPg() : initSqlite()).then(d => { impl = d; return d; });
ready.catch(e => console.error('Storage init failed:', e.message));

async function ensure() { if (!impl) await ready; return impl; }

module.exports = {
  ready,
  now: NOW,
  all: async (sql, p) => (await ensure()).all(sql, p),
  get: async (sql, p) => (await ensure()).get(sql, p),
  run: async (sql, p) => (await ensure()).run(sql, p),
  insert: async (sql, p) => (await ensure()).insert(sql, p),
};
