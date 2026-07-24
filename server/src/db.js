'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA wal_autocheckpoint = 1000;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS subscribers (
    uuid       TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    active     INTEGER NOT NULL DEFAULT 1,
    source     TEXT NOT NULL DEFAULT 'admin',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS packages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    message    TEXT NOT NULL DEFAULT '',
    items      TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS deliveries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
    uuid       TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'queued',
    queued_at  TEXT NOT NULL DEFAULT (datetime('now')),
    claimed_at TEXT,
    sent_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries(status);
  CREATE INDEX IF NOT EXISTS idx_deliveries_pkg ON deliveries(package_id, status);

  CREATE TABLE IF NOT EXISTS lookups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL,
    query      TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS kiosk (
    id        INTEGER PRIMARY KEY CHECK (id = 1),
    url       TEXT,
    last_seen TEXT,
    inventory TEXT NOT NULL DEFAULT '[]'
  );
  INSERT OR IGNORE INTO kiosk (id) VALUES (1);
`);

module.exports = db;
