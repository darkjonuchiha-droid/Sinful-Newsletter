'use strict';
const express = require('express');
const db = require('./storage');
const config = require('./config');
const auth = require('./auth');
const { pingKiosk, kioskOnline, kioskRow, UUID_RE, wrap, fireDueSchedules } = require('./kiosk-api');

const router = express.Router();

// ---------- session ----------

router.post('/login', wrap(async (req, res) => {
  const ip = req.ip || 'unknown';
  if (!await auth.loginAllowed(ip)) {
    return res.status(429).json({ error: 'too many attempts — wait a minute' });
  }
  const password = (req.body && req.body.password) || '';
  if (!auth.timingSafeEqualStr(password, config.adminPassword)) {
    await auth.loginFailed(ip);
    return res.status(401).json({ error: 'wrong password' });
  }
  await auth.loginSucceeded(ip);
  res.cookie('sn_auth', auth.makeSessionCookie(), {
    httpOnly: true, sameSite: 'lax', maxAge: config.sessionHours * 3600 * 1000,
  });
  res.json({ ok: true });
}));

router.post('/logout', (req, res) => {
  res.clearCookie('sn_auth');
  res.json({ ok: true });
});

// Everything below requires a session.
router.use(auth.requireAdmin);

// ---------- overview ----------

router.get('/overview', wrap(async (req, res) => {
  // The dashboard is another clock for the scheduler — useful when the
  // kiosk is temporarily offline (deliveries still queue up correctly).
  if (await fireDueSchedules() > 0) await pingKiosk();
  const k = await kioskRow();
  const sending = await db.all(`
    SELECT p.id, p.name,
           SUM(CASE WHEN d.status IN ('queued','inflight') THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN d.status = 'sent' THEN 1 ELSE 0 END) AS sent,
           SUM(CASE WHEN d.status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM deliveries d JOIN packages p ON p.id = d.package_id
    GROUP BY p.id, p.name
    HAVING SUM(CASE WHEN d.status IN ('queued','inflight') THEN 1 ELSE 0 END) > 0
  `);
  res.json({
    subscribers: (await db.get('SELECT COUNT(*) AS n FROM subscribers WHERE active = 1')).n,
    inactive: (await db.get('SELECT COUNT(*) AS n FROM subscribers WHERE active = 0')).n,
    packages: (await db.get('SELECT COUNT(*) AS n FROM packages')).n,
    kioskOnline: await kioskOnline(),
    kioskLastSeen: k ? k.last_seen : null,
    pendingLookups: await db.all(
      "SELECT id, kind, query FROM lookups WHERE status = 'pending' ORDER BY id"),
    sending,
  });
}));

// ---------- subscribers ----------

router.get('/subscribers', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  let rows;
  if (q) {
    const like = `%${q.toLowerCase()}%`;
    rows = await db.all(`
      SELECT * FROM subscribers
      WHERE LOWER(name) LIKE ? OR LOWER(uuid) LIKE ?
      ORDER BY LOWER(name) LIMIT 500
    `, [like, like]);
  } else {
    rows = await db.all('SELECT * FROM subscribers ORDER BY LOWER(name) LIMIT 500');
  }
  res.json({ subscribers: rows });
}));

// Add by UUID or by legacy name (name resolution is delegated to the kiosk).
router.post('/subscribers', wrap(async (req, res) => {
  const input = String((req.body && req.body.input) || '').trim();
  if (!input) return res.status(400).json({ error: 'empty input' });

  if (UUID_RE.test(input)) {
    const uuid = input.toLowerCase();
    const existing = await db.get('SELECT * FROM subscribers WHERE uuid = ?', [uuid]);
    if (existing) {
      await db.run('UPDATE subscribers SET active = 1 WHERE uuid = ?', [uuid]);
      return res.json({ ok: true, note: existing.active ? 'already subscribed' : 'reactivated' });
    }
    await db.run(
      "INSERT INTO subscribers (uuid, name, source, created_at) VALUES (?, '(resolving...)', 'admin', ?)",
      [uuid, db.now()]);
    await db.run("INSERT INTO lookups (kind, query, created_at) VALUES ('key2name', ?, ?)",
      [uuid, db.now()]);
    await pingKiosk();
    return res.json({ ok: true, note: 'added — name resolving via kiosk' });
  }

  if (input.length > 63 || input.split(/\s+/).length > 2) {
    return res.status(400).json({ error: 'enter a UUID or a legacy name like "Lelouch Resident"' });
  }
  const dupe = await db.get(`
    SELECT id FROM lookups
    WHERE kind = 'name2key' AND status = 'pending' AND LOWER(query) = LOWER(?)
  `, [input]);
  if (!dupe) {
    await db.run("INSERT INTO lookups (kind, query, created_at) VALUES ('name2key', ?, ?)",
      [input, db.now()]);
  }
  await pingKiosk();
  res.json({ ok: true, note: 'looking up name via kiosk — appears in the list once resolved' });
}));

router.patch('/subscribers/:uuid', wrap(async (req, res) => {
  const active = req.body && req.body.active ? 1 : 0;
  const r = await db.run('UPDATE subscribers SET active = ? WHERE uuid = ?',
    [active, String(req.params.uuid).toLowerCase()]);
  if (!r.changes) return res.status(404).json({ error: 'no such subscriber' });
  res.json({ ok: true });
}));

router.delete('/subscribers/:uuid', wrap(async (req, res) => {
  const r = await db.run('DELETE FROM subscribers WHERE uuid = ?',
    [String(req.params.uuid).toLowerCase()]);
  if (!r.changes) return res.status(404).json({ error: 'no such subscriber' });
  res.json({ ok: true });
}));

// ---------- packages ----------

async function packageStats(id) {
  return db.get(`
    SELECT
      SUM(CASE WHEN status IN ('queued','inflight') THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM deliveries WHERE package_id = ?
  `, [id]);
}

router.get('/packages', wrap(async (req, res) => {
  const rows = await db.all('SELECT * FROM packages ORDER BY id DESC');
  const packages = [];
  for (const p of rows) {
    packages.push({ ...p, items: JSON.parse(p.items), stats: await packageStats(p.id) });
  }
  res.json({ packages });
}));

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

router.post('/packages', wrap(async (req, res) => {
  const v = validPackageBody(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const id = await db.insert(
    'INSERT INTO packages (name, message, items, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [v.name, v.message, JSON.stringify(v.items), db.now(), db.now()]);
  res.json({ ok: true, id });
}));

router.put('/packages/:id', wrap(async (req, res) => {
  const v = validPackageBody(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const r = await db.run(
    'UPDATE packages SET name = ?, message = ?, items = ?, updated_at = ? WHERE id = ?',
    [v.name, v.message, JSON.stringify(v.items), db.now(), Number(req.params.id)]);
  if (!r.changes) return res.status(404).json({ error: 'no such package' });
  res.json({ ok: true });
}));

router.delete('/packages/:id', wrap(async (req, res) => {
  const r = await db.run('DELETE FROM packages WHERE id = ?', [Number(req.params.id)]);
  if (!r.changes) return res.status(404).json({ error: 'no such package' });
  res.json({ ok: true });
}));

// Send to every active subscriber.
router.post('/packages/:id/send', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const pkg = await db.get('SELECT id FROM packages WHERE id = ?', [id]);
  if (!pkg) return res.status(404).json({ error: 'no such package' });
  const r = await db.run(`
    INSERT INTO deliveries (package_id, uuid, status, queued_at)
    SELECT ?, uuid, 'queued', ? FROM subscribers WHERE active = 1
  `, [id, db.now()]);
  await pingKiosk();
  res.json({ ok: true, queued: r.changes, kioskOnline: await kioskOnline() });
}));

// Send to a single avatar (UUID, or the name of an existing subscriber).
router.post('/packages/:id/sendto', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const pkg = await db.get('SELECT id FROM packages WHERE id = ?', [id]);
  if (!pkg) return res.status(404).json({ error: 'no such package' });
  const input = String((req.body && req.body.input) || '').trim();
  let uuid = null;
  if (UUID_RE.test(input)) {
    uuid = input.toLowerCase();
  } else {
    const sub = await db.get('SELECT uuid FROM subscribers WHERE LOWER(name) = LOWER(?)', [input]);
    if (sub) uuid = sub.uuid;
  }
  if (!uuid) {
    return res.status(400).json({ error: 'enter a UUID, or the exact name of an existing subscriber' });
  }
  await db.run('INSERT INTO deliveries (package_id, uuid, status, queued_at) VALUES (?, ?, ?, ?)',
    [id, uuid, 'queued', db.now()]);
  await pingKiosk();
  res.json({ ok: true, kioskOnline: await kioskOnline() });
}));

// ---------- schedules ----------

// Program a package to be sent at a future time.
router.post('/packages/:id/schedule', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const pkg = await db.get('SELECT id FROM packages WHERE id = ?', [id]);
  if (!pkg) return res.status(404).json({ error: 'no such package' });
  const t = new Date(String((req.body && req.body.send_at) || ''));
  if (isNaN(t)) return res.status(400).json({ error: 'invalid date/time' });
  if (t.getTime() < Date.now() - 60000) {
    return res.status(400).json({ error: 'that time is in the past' });
  }
  const sid = await db.insert(
    "INSERT INTO schedules (package_id, send_at, status, created_at) VALUES (?, ?, 'pending', ?)",
    [id, t.toISOString(), db.now()]);
  res.json({ ok: true, id: sid });
}));

// All schedules (pending + history) with package names, newest-relevant first.
router.get('/schedules', wrap(async (req, res) => {
  const rows = await db.all(`
    SELECT s.id, s.package_id, s.send_at, s.status, s.fired_at, p.name
    FROM schedules s JOIN packages p ON p.id = s.package_id
    ORDER BY s.send_at DESC LIMIT 300
  `);
  res.json({ schedules: rows });
}));

// Cancel a pending schedule.
router.delete('/schedules/:id', wrap(async (req, res) => {
  const r = await db.run(
    "UPDATE schedules SET status = 'cancelled' WHERE id = ? AND status = 'pending'",
    [Number(req.params.id)]);
  if (!r.changes) return res.status(404).json({ error: 'no pending schedule with that id' });
  res.json({ ok: true });
}));

// ---------- deliveries / kiosk ----------

router.get('/deliveries', wrap(async (req, res) => {
  const pkgId = Number(req.query.package_id) || 0;
  const rows = await db.all(`
    SELECT d.id, d.uuid, d.status, d.queued_at, d.sent_at, s.name
    FROM deliveries d LEFT JOIN subscribers s ON s.uuid = d.uuid
    WHERE d.package_id = ? ORDER BY d.id DESC LIMIT 100
  `, [pkgId]);
  res.json({ deliveries: rows, stats: await packageStats(pkgId) });
}));

// NOTE: named /kiosk-status (not /kiosk) so it can't be captured by the
// kiosk router mounted at /api/kiosk, whose token check runs for every
// path under that mount.
router.get('/kiosk-status', wrap(async (req, res) => {
  const k = await kioskRow();
  res.json({
    online: await kioskOnline(),
    lastSeen: k ? k.last_seen : null,
    inventory: k ? JSON.parse(k.inventory) : [],
  });
}));

module.exports = { router };
