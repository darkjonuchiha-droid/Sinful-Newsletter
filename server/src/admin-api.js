'use strict';
const express = require('express');
const db = require('./db');
const config = require('./config');
const auth = require('./auth');
const { pingKiosk, kioskOnline, kioskRow, UUID_RE } = require('./kiosk-api');

const router = express.Router();

// ---------- session ----------

router.post('/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (!auth.loginAllowed(ip)) {
    return res.status(429).json({ error: 'too many attempts — wait a minute' });
  }
  const password = (req.body && req.body.password) || '';
  if (!auth.timingSafeEqualStr(password, config.adminPassword)) {
    auth.loginFailed(ip);
    return res.status(401).json({ error: 'wrong password' });
  }
  auth.loginSucceeded(ip);
  res.cookie('sn_auth', auth.makeSessionCookie(), {
    httpOnly: true, sameSite: 'lax', maxAge: config.sessionHours * 3600 * 1000,
  });
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  res.clearCookie('sn_auth');
  res.json({ ok: true });
});

// Everything below requires a session.
router.use(auth.requireAdmin);

// ---------- overview ----------

router.get('/overview', (req, res) => {
  const k = kioskRow();
  const sending = db.prepare(`
    SELECT p.id, p.name,
           SUM(CASE WHEN d.status IN ('queued','inflight') THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN d.status = 'sent' THEN 1 ELSE 0 END) AS sent,
           SUM(CASE WHEN d.status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM deliveries d JOIN packages p ON p.id = d.package_id
    GROUP BY p.id HAVING pending > 0
  `).all();
  res.json({
    subscribers: db.prepare('SELECT COUNT(*) AS n FROM subscribers WHERE active = 1').get().n,
    inactive: db.prepare('SELECT COUNT(*) AS n FROM subscribers WHERE active = 0').get().n,
    packages: db.prepare('SELECT COUNT(*) AS n FROM packages').get().n,
    kioskOnline: kioskOnline(),
    kioskLastSeen: k ? k.last_seen : null,
    pendingLookups: db.prepare("SELECT id, kind, query FROM lookups WHERE status = 'pending' ORDER BY id").all(),
    sending,
  });
});

// ---------- subscribers ----------

router.get('/subscribers', (req, res) => {
  const q = String(req.query.q || '').trim();
  let rows;
  if (q) {
    rows = db.prepare(`
      SELECT * FROM subscribers
      WHERE name LIKE ? OR uuid LIKE ?
      ORDER BY name COLLATE NOCASE LIMIT 500
    `).all(`%${q}%`, `%${q}%`);
  } else {
    rows = db.prepare('SELECT * FROM subscribers ORDER BY name COLLATE NOCASE LIMIT 500').all();
  }
  res.json({ subscribers: rows });
});

// Add by UUID or by legacy name (name resolution is delegated to the kiosk).
router.post('/subscribers', (req, res) => {
  const input = String((req.body && req.body.input) || '').trim();
  if (!input) return res.status(400).json({ error: 'empty input' });

  if (UUID_RE.test(input)) {
    const uuid = input.toLowerCase();
    const existing = db.prepare('SELECT * FROM subscribers WHERE uuid = ?').get(uuid);
    if (existing) {
      db.prepare('UPDATE subscribers SET active = 1 WHERE uuid = ?').run(uuid);
      return res.json({ ok: true, note: existing.active ? 'already subscribed' : 'reactivated' });
    }
    db.prepare("INSERT INTO subscribers (uuid, name, source) VALUES (?, '(resolving...)', 'admin')").run(uuid);
    db.prepare("INSERT INTO lookups (kind, query) VALUES ('key2name', ?)").run(uuid);
    pingKiosk();
    return res.json({ ok: true, note: 'added — name resolving via kiosk' });
  }

  if (input.length > 63 || input.split(/\s+/).length > 2) {
    return res.status(400).json({ error: 'enter a UUID or a legacy name like "Lelouch Resident"' });
  }
  const dupe = db.prepare(
    "SELECT id FROM lookups WHERE kind = 'name2key' AND status = 'pending' AND query = ? COLLATE NOCASE"
  ).get(input);
  if (!dupe) {
    db.prepare("INSERT INTO lookups (kind, query) VALUES ('name2key', ?)").run(input);
  }
  pingKiosk();
  res.json({ ok: true, note: 'looking up name via kiosk — appears in the list once resolved' });
});

router.patch('/subscribers/:uuid', (req, res) => {
  const active = req.body && req.body.active ? 1 : 0;
  const r = db.prepare('UPDATE subscribers SET active = ? WHERE uuid = ?')
    .run(active, String(req.params.uuid).toLowerCase());
  if (!r.changes) return res.status(404).json({ error: 'no such subscriber' });
  res.json({ ok: true });
});

router.delete('/subscribers/:uuid', (req, res) => {
  const r = db.prepare('DELETE FROM subscribers WHERE uuid = ?')
    .run(String(req.params.uuid).toLowerCase());
  if (!r.changes) return res.status(404).json({ error: 'no such subscriber' });
  res.json({ ok: true });
});

// ---------- packages ----------

function packageStats(id) {
  return db.prepare(`
    SELECT
      SUM(CASE WHEN status IN ('queued','inflight') THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM deliveries WHERE package_id = ?
  `).get(id);
}

router.get('/packages', (req, res) => {
  const rows = db.prepare('SELECT * FROM packages ORDER BY id DESC').all();
  res.json({
    packages: rows.map(p => ({
      ...p, items: JSON.parse(p.items), stats: packageStats(p.id),
    })),
  });
});

function validPackageBody(body) {
  const name = String((body && body.name) || '').trim();
  const message = String((body && body.message) || '').trim();
  let items = (body && body.items) || [];
  if (!name || name.length > 60) return { error: 'package name required (max 60 chars)' };
  if (message.length > 800) return { error: 'message too long (max 800 chars — SL IM limit)' };
  if (!Array.isArray(items)) return { error: 'items must be an array' };
  items = items.filter(i => typeof i === 'string' && i.length > 0).slice(0, 42);
  return { name, message, items };
}

router.post('/packages', (req, res) => {
  const v = validPackageBody(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const r = db.prepare('INSERT INTO packages (name, message, items) VALUES (?, ?, ?)')
    .run(v.name, v.message, JSON.stringify(v.items));
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});

router.put('/packages/:id', (req, res) => {
  const v = validPackageBody(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const r = db.prepare(`
    UPDATE packages SET name = ?, message = ?, items = ?, updated_at = datetime('now') WHERE id = ?
  `).run(v.name, v.message, JSON.stringify(v.items), Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'no such package' });
  res.json({ ok: true });
});

router.delete('/packages/:id', (req, res) => {
  const r = db.prepare('DELETE FROM packages WHERE id = ?').run(Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'no such package' });
  res.json({ ok: true });
});

// Send to every active subscriber.
router.post('/packages/:id/send', (req, res) => {
  const id = Number(req.params.id);
  const pkg = db.prepare('SELECT id FROM packages WHERE id = ?').get(id);
  if (!pkg) return res.status(404).json({ error: 'no such package' });
  const r = db.prepare(`
    INSERT INTO deliveries (package_id, uuid)
    SELECT ?, uuid FROM subscribers WHERE active = 1
  `).run(id);
  pingKiosk();
  res.json({ ok: true, queued: r.changes, kioskOnline: kioskOnline() });
});

// Send to a single avatar (UUID, or the name of an existing subscriber).
router.post('/packages/:id/sendto', (req, res) => {
  const id = Number(req.params.id);
  const pkg = db.prepare('SELECT id FROM packages WHERE id = ?').get(id);
  if (!pkg) return res.status(404).json({ error: 'no such package' });
  const input = String((req.body && req.body.input) || '').trim();
  let uuid = null;
  if (UUID_RE.test(input)) {
    uuid = input.toLowerCase();
  } else {
    const sub = db.prepare('SELECT uuid FROM subscribers WHERE name = ? COLLATE NOCASE').get(input);
    if (sub) uuid = sub.uuid;
  }
  if (!uuid) {
    return res.status(400).json({ error: 'enter a UUID, or the exact name of an existing subscriber' });
  }
  db.prepare('INSERT INTO deliveries (package_id, uuid) VALUES (?, ?)').run(id, uuid);
  pingKiosk();
  res.json({ ok: true, kioskOnline: kioskOnline() });
});

// ---------- deliveries / kiosk ----------

router.get('/deliveries', (req, res) => {
  const pkgId = Number(req.query.package_id) || 0;
  const rows = db.prepare(`
    SELECT d.id, d.uuid, d.status, d.queued_at, d.sent_at, s.name
    FROM deliveries d LEFT JOIN subscribers s ON s.uuid = d.uuid
    WHERE d.package_id = ? ORDER BY d.id DESC LIMIT 100
  `).all(pkgId);
  res.json({ deliveries: rows, stats: packageStats(pkgId) });
});

// NOTE: named /kiosk-status (not /kiosk) so it can't be captured by the
// kiosk router mounted at /api/kiosk, whose token check runs for every
// path under that mount.
router.get('/kiosk-status', (req, res) => {
  const k = kioskRow();
  res.json({
    online: kioskOnline(),
    lastSeen: k ? k.last_seen : null,
    inventory: k ? JSON.parse(k.inventory) : [],
  });
});

module.exports = { router };
