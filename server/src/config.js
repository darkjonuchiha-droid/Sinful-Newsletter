'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Minimal .env loader — real env vars win over file values.
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const config = {
  port: Number(process.env.PORT) || 8710,
  adminPassword: process.env.ADMIN_PASSWORD || '',
  kioskToken: process.env.KIOSK_TOKEN || '',
  // Postgres (Neon/Supabase/...) when set; embedded SQLite otherwise.
  databaseUrl: process.env.DATABASE_URL || '',
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'newsletter.db'),
  // Kiosk counts as offline when silent longer than this.
  kioskOfflineMs: 12 * 60 * 1000,
  // Inflight deliveries older than this are assumed lost and requeued.
  inflightRequeueMs: 10 * 60 * 1000,
  sessionHours: 8,
};

if (!config.adminPassword || config.adminPassword === 'change-me') {
  console.error('Set a real ADMIN_PASSWORD in server/.env (copy .env.example).');
  process.exit(1);
}
if (!config.kioskToken || config.kioskToken === 'change-me-too') {
  console.error('Set a real KIOSK_TOKEN in server/.env (copy .env.example).');
  process.exit(1);
}
if (process.env.VERCEL && !config.databaseUrl) {
  console.error('Running on Vercel requires DATABASE_URL (serverless has no persistent disk '
    + 'for SQLite). Add a Neon/Postgres integration and set DATABASE_URL.');
  process.exit(1);
}

module.exports = config;
