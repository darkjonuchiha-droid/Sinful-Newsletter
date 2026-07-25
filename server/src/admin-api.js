'use strict';
const express = require('express');
const db = require('./storage');
const config = require('./config');
const auth = require('./auth');
const { pingKiosk, kioskOnline, kioskRow, UUID_RE, wrap, fireDueSchedules,
  queueAudience, SPECIAL_LISTS } = require('./kiosk-api');

const specialName = (id) => (SPECIAL_LISTS[String(id)] || {}).name;

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
  const satellites = (await db.all('SELECT * FROM satellites ORDER BY label')).map(s => ({
    label: s.label, region: s.region, list: s.list_name, lastSeen: s.last_seen,
    online: Date.now() - Date.parse(s.last_seen) < config.kioskOfflineMs,
  }));
  res.json({
    subscribers: (await db.get('SELECT COUNT(*) AS n FROM subscribers WHERE active = 1')).n,
    inactive: (await db.get('SELECT COUNT(*) AS n FROM subscribers WHERE active = 0')).n,
    packages: (await db.get('SELECT COUNT(*) AS n FROM packages')).n,
    kioskOnline: await kioskOnline(),
    kioskLastSeen: k ? k.last_seen : null,
    satellites,
    pendingLookups: await db.all(
      "SELECT id, kind, query FROM lookups WHERE status = 'pending' ORDER BY id"),
    sending,
  });
}));

// ---------- lists ----------

// Names double as kiosk dialog buttons (24-byte LSL limit) and must not
// collide with the kiosk's own button labels.
const RESERVED_LIST_NAMES = ['everything', 'all', 'subscribe', 'unsubscribe',
  'get latest', 'sync', 'status', 'close'];

router.get('/lists', wrap(async (req, res) => {
  const rows = await db.all(`
    SELECT l.id, l.name, COUNT(m.uuid) AS members
    FROM lists l LEFT JOIN list_members m ON m.list_id = l.id
    GROUP BY l.id, l.name ORDER BY LOWER(l.name)
  `);
  // System audiences — computed live from subscriber flags, never stored,
  // never offered by the kiosk's subscribe picker.
  const special = [
    { id: -1, name: SPECIAL_LISTS['-1'].name, icon: '👻',
      members: (await db.get('SELECT COUNT(*) AS n FROM subscribers WHERE shadowbanned = 1')).n },
    { id: -2, name: SPECIAL_LISTS['-2'].name, icon: '💤',
      members: (await db.get('SELECT COUNT(*) AS n FROM subscribers WHERE active = 0')).n },
  ];
  res.json({ lists: rows, special });
}));

router.post('/lists', wrap(async (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  if (!name || name.length > 20) {
    return res.status(400).json({ error: 'list name required, max 20 characters (kiosk button limit)' });
  }
  if (RESERVED_LIST_NAMES.includes(name.toLowerCase())) {
    return res.status(400).json({ error: `"${name}" is reserved — pick another name` });
  }
  const dupe = await db.get('SELECT id FROM lists WHERE LOWER(name) = LOWER(?)', [name]);
  if (dupe) return res.status(400).json({ error: 'a list with that name already exists' });
  const id = await db.insert('INSERT INTO lists (name, created_at) VALUES (?, ?)', [name, db.now()]);
  res.json({ ok: true, id });
}));

router.delete('/lists/:id', wrap(async (req, res) => {
  const r = await db.run('DELETE FROM lists WHERE id = ?', [Number(req.params.id)]);
  if (!r.changes) return res.status(404).json({ error: 'no such list' });
  res.json({ ok: true });
}));

router.post('/lists/:id/members', wrap(async (req, res) => {
  const listId = Number(req.params.id);
  const uuid = String((req.body && req.body.uuid) || '').toLowerCase();
  if (!await db.get('SELECT id FROM lists WHERE id = ?', [listId])) {
    return res.status(404).json({ error: 'no such list' });
  }
  if (!await db.get('SELECT uuid FROM subscribers WHERE uuid = ?', [uuid])) {
    return res.status(404).json({ error: 'no such subscriber' });
  }
  await db.run('INSERT INTO list_members (list_id, uuid) VALUES (?, ?) ON CONFLICT (list_id, uuid) DO NOTHING',
    [listId, uuid]);
  res.json({ ok: true });
}));

router.delete('/lists/:id/members/:uuid', wrap(async (req, res) => {
  await db.run('DELETE FROM list_members WHERE list_id = ? AND uuid = ?',
    [Number(req.params.id), String(req.params.uuid).toLowerCase()]);
  res.json({ ok: true });
}));

// ---------- subscribers ----------

router.get('/subscribers', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const listId = Number(req.query.list) || 0;
  let sql = 'SELECT s.* FROM subscribers s';
  const params = [];
  const where = [];
  if (listId < 0) {
    const spec = SPECIAL_LISTS[String(listId)];
    if (spec) where.push(spec.where);
  } else if (listId > 0) {
    sql += ' JOIN list_members m ON m.uuid = s.uuid AND m.list_id = ?';
    params.push(listId);
  }
  if (q) {
    // Lowercased comparison handles ASCII case; the raw comparison also
    // covers accented/unicode names on SQLite, whose LOWER() is ASCII-only
    // (Postgres lowercases unicode correctly, so both paths are covered).
    const like = `%${q.toLowerCase()}%`;
    const raw = `%${q}%`;
    where.push(`(LOWER(s.name) LIKE ? OR s.name LIKE ?
      OR LOWER(s.display_name) LIKE ? OR s.display_name LIKE ?
      OR LOWER(s.uuid) LIKE ?)`);
    params.push(like, raw, like, raw, like);
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY LOWER(s.name) LIMIT 500';
  const rows = await db.all(sql, params);
  // Attach each subscriber's list memberships (portable: assembled in JS).
  const mem = await db.all(
    'SELECT m.uuid, l.id, l.name FROM list_members m JOIN lists l ON l.id = m.list_id');
  const byUuid = {};
  for (const m of mem) (byUuid[m.uuid] = byUuid[m.uuid] || []).push({ id: m.id, name: m.name });
  res.json({ subscribers: rows.map(r => ({ ...r, lists: byUuid[r.uuid] || [] })) });
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

// Re-resolve display names: clears them and drops the one-shot lookup rows
// so /work re-queues them (used after a kiosk script update, or when
// someone changes their display name in-world).
router.post('/subscribers/refresh-display', wrap(async (req, res) => {
  let uuids = (req.body && req.body.uuids) || [];
  if (!Array.isArray(uuids)) uuids = [];
  uuids = uuids.filter(u => typeof u === 'string' && UUID_RE.test(u))
    .map(u => u.toLowerCase()).slice(0, 500);
  let n;
  if (uuids.length) {
    const ph = uuids.map(() => '?').join(',');
    n = (await db.run(`UPDATE subscribers SET display_name = '' WHERE uuid IN (${ph})`, uuids)).changes;
    await db.run(`DELETE FROM lookups WHERE kind = 'key2disp' AND query IN (${ph})`, uuids);
  } else {
    n = (await db.run("UPDATE subscribers SET display_name = ''")).changes;
    await db.run("DELETE FROM lookups WHERE kind = 'key2disp'");
  }
  await pingKiosk();
  res.json({ ok: true, queued: n });
}));

// Bulk operations on a set of subscribers.
router.post('/subscribers/bulk', wrap(async (req, res) => {
  const action = String((req.body && req.body.action) || '');
  let uuids = (req.body && req.body.uuids) || [];
  if (!Array.isArray(uuids)) return res.status(400).json({ error: 'uuids must be an array' });
  uuids = uuids.filter(u => typeof u === 'string' && UUID_RE.test(u))
    .map(u => u.toLowerCase()).slice(0, 500);
  if (!uuids.length) return res.status(400).json({ error: 'no valid subscribers selected' });
  const ph = uuids.map(() => '?').join(',');

  if (action === 'activate' || action === 'deactivate') {
    const r = await db.run(
      `UPDATE subscribers SET active = ? WHERE uuid IN (${ph})`,
      [action === 'activate' ? 1 : 0, ...uuids]);
    return res.json({ ok: true, affected: r.changes });
  }
  if (action === 'shadowban' || action === 'unshadowban') {
    const r = await db.run(
      `UPDATE subscribers SET shadowbanned = ? WHERE uuid IN (${ph})`,
      [action === 'shadowban' ? 1 : 0, ...uuids]);
    return res.json({ ok: true, affected: r.changes });
  }
  if (action === 'delete') {
    const r = await db.run(`DELETE FROM subscribers WHERE uuid IN (${ph})`, uuids);
    return res.json({ ok: true, affected: r.changes });
  }
  if (action === 'addlist' || action === 'removelist') {
    const listId = Number(req.body.list_id) || 0;
    if (!await db.get('SELECT id FROM lists WHERE id = ?', [listId])) {
      return res.status(404).json({ error: 'no such list' });
    }
    let r;
    if (action === 'addlist') {
      r = await db.run(`
        INSERT INTO list_members (list_id, uuid)
        SELECT ?, uuid FROM subscribers WHERE uuid IN (${ph})
        ON CONFLICT (list_id, uuid) DO NOTHING
      `, [listId, ...uuids]);
    } else {
      r = await db.run(
        `DELETE FROM list_members WHERE list_id = ? AND uuid IN (${ph})`,
        [listId, ...uuids]);
    }
    return res.json({ ok: true, affected: r.changes });
  }
  res.status(400).json({ error: 'unknown action' });
}));

router.patch('/subscribers/:uuid', wrap(async (req, res) => {
  const body = req.body || {};
  const sets = [];
  const params = [];
  if ('active' in body) { sets.push('active = ?'); params.push(body.active ? 1 : 0); }
  if ('shadowbanned' in body) { sets.push('shadowbanned = ?'); params.push(body.shadowbanned ? 1 : 0); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  params.push(String(req.params.uuid).toLowerCase());
  const r = await db.run(`UPDATE subscribers SET ${sets.join(', ')} WHERE uuid = ?`, params);
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
  const stats = await db.get(`
    SELECT
      SUM(CASE WHEN status IN ('queued','inflight') THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      COUNT(DISTINCT CASE WHEN status = 'sent' THEN uuid END) AS reached
    FROM deliveries WHERE package_id = ?
  `, [id]);
  // Audiences this package has been sent to (0 = all-subscriber blast).
  const rows = await db.all(`
    SELECT DISTINCT d.list_id, l.name FROM deliveries d
    LEFT JOIN lists l ON l.id = d.list_id
    WHERE d.package_id = ? AND d.list_id IS NOT NULL
  `, [id]);
  stats.audiences = rows.map(r => {
    if (r.list_id === 0) return 'All subscribers';
    if (r.list_id < 0) return specialName(r.list_id) || '(system)';
    return r.name || '(deleted list)';
  }).sort();
  return stats;
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
  return { name, message, items, onlyOnline: body && body.only_online ? 1 : 0 };
}

router.post('/packages', wrap(async (req, res) => {
  const v = validPackageBody(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const id = await db.insert(
    'INSERT INTO packages (name, message, items, only_online, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [v.name, v.message, JSON.stringify(v.items), v.onlyOnline, db.now(), db.now()]);
  res.json({ ok: true, id });
}));

router.put('/packages/:id', wrap(async (req, res) => {
  const v = validPackageBody(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const r = await db.run(
    'UPDATE packages SET name = ?, message = ?, items = ?, only_online = ?, updated_at = ? WHERE id = ?',
    [v.name, v.message, JSON.stringify(v.items), v.onlyOnline, db.now(), Number(req.params.id)]);
  if (!r.changes) return res.status(404).json({ error: 'no such package' });
  res.json({ ok: true });
}));

router.delete('/packages/:id', wrap(async (req, res) => {
  const r = await db.run('DELETE FROM packages WHERE id = ?', [Number(req.params.id)]);
  if (!r.changes) return res.status(404).json({ error: 'no such package' });
  res.json({ ok: true });
}));

// Send to every active subscriber, or to one or more lists.
// Body: {} = all; { list_ids: [1,2] } (or legacy { list_id: 1 }) = those lists.
// Members of several selected lists get exactly ONE delivery, and anyone
// already queued for this package is not queued again.
router.post('/packages/:id/send', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const pkg = await db.get('SELECT id FROM packages WHERE id = ?', [id]);
  if (!pkg) return res.status(404).json({ error: 'no such package' });

  // Positive ids = real lists; negative = system audiences (shadow-banned,
  // inactive) which are deliberately targetable but never auto-included.
  let listIds = (req.body && req.body.list_ids) || [];
  if (!Array.isArray(listIds)) listIds = [];
  listIds = [...new Set(listIds.map(Number)
    .filter(n => Number.isInteger(n) && (n > 0 || SPECIAL_LISTS[String(n)])))];
  const legacy = Number(req.body && req.body.list_id) || 0;
  if (legacy && !listIds.length) listIds = [legacy];

  // Optional per-send only-online override (NULL = use the package's flag).
  let oo = null;
  if (req.body && 'only_online' in req.body) oo = req.body.only_online ? 1 : 0;

  let queued = 0;
  if (listIds.length) {
    for (const lid of listIds) {
      if (lid > 0 && !await db.get('SELECT id FROM lists WHERE id = ?', [lid])) {
        return res.status(404).json({ error: `no such list (id ${lid})` });
      }
    }
    for (const lid of listIds) queued += await queueAudience(id, lid, oo);
  } else {
    queued = await queueAudience(id, 0, oo);
  }
  await pingKiosk();
  res.json({ ok: true, queued, kioskOnline: await kioskOnline() });
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
  // Shadow-banned recipients require an explicit force flag (the UI asks).
  const sub = await db.get('SELECT name, shadowbanned FROM subscribers WHERE uuid = ?', [uuid]);
  if (sub && sub.shadowbanned && !(req.body && req.body.force)) {
    return res.status(409).json({
      error: `${sub.name} is shadow-banned`, shadowbanned: true, name: sub.name,
    });
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
  const listId = Number(req.body && req.body.list_id) || 0;
  if (listId > 0 && !await db.get('SELECT id FROM lists WHERE id = ?', [listId])) {
    return res.status(404).json({ error: 'no such list' });
  }
  if (listId < 0 && !SPECIAL_LISTS[String(listId)]) {
    return res.status(404).json({ error: 'no such audience' });
  }
  const sid = await db.insert(
    "INSERT INTO schedules (package_id, send_at, status, created_at, list_id) VALUES (?, ?, 'pending', ?, ?)",
    [id, t.toISOString(), db.now(), listId || null]);
  res.json({ ok: true, id: sid });
}));

// All schedules (pending + history) with package names, newest-relevant first.
router.get('/schedules', wrap(async (req, res) => {
  const rows = await db.all(`
    SELECT s.id, s.package_id, s.send_at, s.status, s.fired_at, s.list_id,
           p.name, l.name AS list_name
    FROM schedules s JOIN packages p ON p.id = s.package_id
    LEFT JOIN lists l ON l.id = s.list_id
    ORDER BY s.send_at DESC LIMIT 300
  `);
  res.json({
    schedules: rows.map(r => ({
      ...r,
      list_name: r.list_id < 0 ? specialName(r.list_id) : r.list_name,
    })),
  });
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
  // Audiences this package was sent to, with ids so the UI can re-send.
  const audiences = (await db.all(`
    SELECT DISTINCT d.list_id, l.name FROM deliveries d
    LEFT JOIN lists l ON l.id = d.list_id
    WHERE d.package_id = ? AND d.list_id IS NOT NULL
  `, [pkgId])).map(a => ({
    list_id: a.list_id,
    // null name on a positive id = the list was deleted
    name: a.list_id === 0 ? 'All subscribers'
      : (a.list_id < 0 ? (specialName(a.list_id) || '(system)') : a.name),
  }));
  res.json({ deliveries: rows, stats: await packageStats(pkgId), audiences });
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
