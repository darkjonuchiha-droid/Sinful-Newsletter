'use strict';
const express = require('express');
const db = require('./db');
const config = require('./config');
const { requireKiosk } = require('./auth');

const router = express.Router();
router.use(requireKiosk);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- helpers shared with admin API ----------

function kioskRow() {
  return db.prepare('SELECT * FROM kiosk WHERE id = 1').get();
}

function kioskOnline() {
  const k = kioskRow();
  if (!k || !k.last_seen) return false;
  return Date.now() - Date.parse(k.last_seen + 'Z') < config.kioskOfflineMs;
}

// Fire-and-forget "you have work" nudge to the kiosk's HTTP-in URL.
function pingKiosk() {
  const k = kioskRow();
  if (!k || !k.url) return;
  fetch(k.url, {
    method: 'POST',
    body: 'work',
    signal: AbortSignal.timeout(5000),
  }).catch(() => { /* kiosk will pick work up on its next heartbeat */ });
}

function latestPackage() {
  const p = db.prepare('SELECT id, name, message, items FROM packages ORDER BY id DESC LIMIT 1').get();
  if (!p) return null;
  return { id: p.id, name: p.name, msg: p.message, items: JSON.parse(p.items) };
}

function touchKiosk() {
  db.prepare("UPDATE kiosk SET last_seen = datetime('now') WHERE id = 1").run();
}

// ---------- endpoints ----------

// Registration + heartbeat + inventory report.
router.post('/hello', (req, res) => {
  const { url, inventory } = req.body || {};
  if (typeof url === 'string' && url.startsWith('http')) {
    db.prepare('UPDATE kiosk SET url = ? WHERE id = 1').run(url);
  }
  if (Array.isArray(inventory)) {
    const clean = inventory
      .filter(i => i && typeof i.name === 'string')
      .map(i => ({ name: i.name, type: String(i.type || 'item'), ok: i.ok ? 1 : 0 }));
    db.prepare('UPDATE kiosk SET inventory = ? WHERE id = 1').run(JSON.stringify(clean));
  }
  touchKiosk();
  const queued = db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'queued'").get().n;
  const lookups = db.prepare("SELECT COUNT(*) AS n FROM lookups WHERE status = 'pending'").get().n;
  res.json({ latest: latestPackage(), queued, lookups });
});

// Work batch: pending lookups + a few queued deliveries (claimed as inflight).
router.get('/work', (req, res) => {
  touchKiosk();
  // Requeue deliveries a dead kiosk claimed and never reported.
  db.prepare(`
    UPDATE deliveries SET status = 'queued', claimed_at = NULL
    WHERE status = 'inflight'
      AND (julianday('now') - julianday(claimed_at)) * 86400000 > ?
  `).run(config.inflightRequeueMs);

  const lookups = db.prepare(
    "SELECT id, kind, query FROM lookups WHERE status = 'pending' ORDER BY id LIMIT 5"
  ).all();

  const rows = db.prepare(`
    SELECT d.id, d.uuid, p.name, p.message, p.items
    FROM deliveries d JOIN packages p ON p.id = d.package_id
    WHERE d.status = 'queued' ORDER BY d.id LIMIT 3
  `).all();
  const claim = db.prepare("UPDATE deliveries SET status = 'inflight', claimed_at = datetime('now') WHERE id = ?");
  const deliveries = rows.map(r => {
    claim.run(r.id);
    return { id: r.id, uuid: r.uuid, pkg: { name: r.name, msg: r.message, items: JSON.parse(r.items) } };
  });

  res.json({ lookups, deliveries });
});

// Results: delivery outcomes and lookup answers.
router.post('/report', (req, res) => {
  const { deliveries, lookups } = req.body || {};
  if (Array.isArray(deliveries)) {
    const done = db.prepare("UPDATE deliveries SET status = ?, sent_at = datetime('now') WHERE id = ?");
    for (const d of deliveries) {
      if (!d || !Number.isInteger(d.id)) continue;
      done.run(d.status === 'failed' ? 'failed' : 'sent', d.id);
    }
  }
  if (Array.isArray(lookups)) {
    for (const l of lookups) {
      if (!l || !Number.isInteger(l.id)) continue;
      const row = db.prepare('SELECT * FROM lookups WHERE id = ?').get(l.id);
      if (!row || row.status !== 'pending') continue;
      if (row.kind === 'name2key' && typeof l.uuid === 'string' && UUID_RE.test(l.uuid)) {
        db.prepare(`
          INSERT INTO subscribers (uuid, name, source) VALUES (?, ?, 'admin')
          ON CONFLICT(uuid) DO UPDATE SET active = 1
        `).run(l.uuid.toLowerCase(), row.query);
        db.prepare("UPDATE lookups SET status = 'done' WHERE id = ?").run(l.id);
      } else if (row.kind === 'key2name' && typeof l.name === 'string' && l.name.length > 0) {
        db.prepare('UPDATE subscribers SET name = ? WHERE uuid = ?').run(l.name, row.query);
        db.prepare("UPDATE lookups SET status = 'done' WHERE id = ?").run(l.id);
      } else {
        db.prepare("UPDATE lookups SET status = 'notfound' WHERE id = ?").run(l.id);
        if (row.kind === 'key2name') {
          // Leave the subscriber with the raw UUID visible as its name.
          db.prepare("UPDATE subscribers SET name = ? WHERE uuid = ? AND name = '(resolving...)'")
            .run(row.query, row.query);
        }
      }
    }
  }
  touchKiosk();
  res.json({ ok: true });
});

// In-world subscribe/unsubscribe touches.
router.post('/event', (req, res) => {
  const { type, uuid, name } = req.body || {};
  if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) {
    return res.status(400).json({ error: 'bad uuid' });
  }
  const u = uuid.toLowerCase();
  if (type === 'sub') {
    db.prepare(`
      INSERT INTO subscribers (uuid, name, source) VALUES (?, ?, 'kiosk')
      ON CONFLICT(uuid) DO UPDATE SET active = 1, name = excluded.name
    `).run(u, typeof name === 'string' && name ? name : u);
  } else if (type === 'unsub') {
    db.prepare('UPDATE subscribers SET active = 0 WHERE uuid = ?').run(u);
  } else {
    return res.status(400).json({ error: 'bad type' });
  }
  touchKiosk();
  res.json({ ok: true });
});

// Redelivery: latest package for one avatar (logged as a delivery).
router.get('/latest', (req, res) => {
  const uuid = String(req.query.uuid || '').toLowerCase();
  const pkg = latestPackage();
  if (!pkg) return res.json({ latest: null });
  if (UUID_RE.test(uuid)) {
    db.prepare(`
      INSERT INTO deliveries (package_id, uuid, status, sent_at)
      VALUES (?, ?, 'sent', datetime('now'))
    `).run(pkg.id, uuid);
  }
  touchKiosk();
  res.json({ latest: pkg });
});

module.exports = { router, pingKiosk, kioskOnline, kioskRow, UUID_RE };
