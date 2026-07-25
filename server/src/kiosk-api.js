'use strict';
const express = require('express');
const db = require('./storage');
const config = require('./config');
const { requireKiosk, unsubToken } = require('./auth');

const router = express.Router();
router.use(requireKiosk);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

// ---------- helpers shared with admin API ----------

async function kioskRow() {
  return db.get('SELECT * FROM kiosk WHERE id = 1');
}

async function kioskOnline() {
  const k = await kioskRow();
  if (!k || !k.last_seen) return false;
  return Date.now() - Date.parse(k.last_seen) < config.kioskOfflineMs;
}

// "You have work" nudge to the kiosk's HTTP-in URL. Awaited by callers so it
// isn't lost when a serverless invocation freezes after the response.
async function pingKiosk() {
  const k = await kioskRow();
  if (!k || !k.url) return;
  try {
    await fetch(k.url, { method: 'POST', body: 'work', signal: AbortSignal.timeout(2500) });
  } catch { /* kiosk will pick work up on its next heartbeat */ }
}

async function latestPackage() {
  const p = await db.get('SELECT id, name, message, items FROM packages ORDER BY id DESC LIMIT 1');
  if (!p) return null;
  return { id: p.id, name: p.name, msg: p.message, items: JSON.parse(p.items) };
}

async function touchKiosk() {
  await db.run('UPDATE kiosk SET last_seen = ? WHERE id = 1', [db.now()]);
}

// Per-recipient unsubscribe footer appended to delivery messages. SL viewers
// render [url text] markup in IMs as a clickable link.
function withFooter(msg, uuid) {
  if (!config.publicUrl) return msg;
  const link = `${config.publicUrl}/u/${uuid}/${unsubToken(uuid)}`;
  const footer = `If you don't want to receive more of these newsletters, click: [${link} Unsubscribe]`;
  return msg ? msg + '\n\n' + footer : footer;
}

// Enqueue deliveries for any schedule whose time has come. Called from the
// kiosk heartbeat/work endpoints (a reliable ~5-min clock on every
// deployment, including serverless), the admin overview, and — when
// self-hosted — a 60 s interval in index.js. Returns how many fired.
async function fireDueSchedules() {
  const due = await db.all(
    "SELECT * FROM schedules WHERE status = 'pending' AND send_at <= ?", [db.now()]);
  let fired = 0;
  for (const s of due) {
    let r;
    if (s.list_id) {
      r = await db.run(`
        INSERT INTO deliveries (package_id, uuid, status, queued_at)
        SELECT ?, sub.uuid, 'queued', ? FROM subscribers sub
        JOIN list_members m ON m.uuid = sub.uuid AND m.list_id = ?
        WHERE sub.active = 1 AND sub.shadowbanned = 0
      `, [s.package_id, db.now(), s.list_id]);
    } else {
      r = await db.run(`
        INSERT INTO deliveries (package_id, uuid, status, queued_at)
        SELECT ?, uuid, 'queued', ? FROM subscribers WHERE active = 1 AND shadowbanned = 0
      `, [s.package_id, db.now()]);
    }
    await db.run("UPDATE schedules SET status = 'sent', fired_at = ? WHERE id = ?",
      [db.now(), s.id]);
    fired += r.changes;
  }
  return fired;
}

// ---------- endpoints ----------

// Registration + heartbeat + inventory report.
router.post('/hello', wrap(async (req, res) => {
  const { url, inventory } = req.body || {};
  if (typeof url === 'string' && url.startsWith('http')) {
    await db.run('UPDATE kiosk SET url = ? WHERE id = 1', [url]);
  }
  if (Array.isArray(inventory)) {
    const clean = inventory
      .filter(i => i && typeof i.name === 'string')
      .map(i => ({ name: i.name, type: String(i.type || 'item'), ok: i.ok ? 1 : 0 }));
    await db.run('UPDATE kiosk SET inventory = ? WHERE id = 1', [JSON.stringify(clean)]);
  }
  await touchKiosk();
  await fireDueSchedules(); // before counting, so fresh sends are picked up now
  const queued = (await db.get("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'queued'")).n;
  const lookups = (await db.get("SELECT COUNT(*) AS n FROM lookups WHERE status = 'pending'")).n;
  const listNames = (await db.all('SELECT name FROM lists ORDER BY LOWER(name)')).map(r => r.name);
  res.json({ latest: await latestPackage(), queued, lookups, listNames });
}));

// Work batch: pending lookups + a few queued deliveries (claimed as inflight).
router.get('/work', wrap(async (req, res) => {
  await touchKiosk();
  await fireDueSchedules();
  // Requeue deliveries a dead kiosk claimed and never reported.
  const cutoff = new Date(Date.now() - config.inflightRequeueMs).toISOString();
  await db.run(`
    UPDATE deliveries SET status = 'queued', claimed_at = NULL
    WHERE status = 'inflight' AND claimed_at < ?
  `, [cutoff]);

  const lookups = await db.all(
    "SELECT id, kind, query FROM lookups WHERE status = 'pending' ORDER BY id LIMIT 5");

  const rows = await db.all(`
    SELECT d.id, d.uuid, p.name, p.message, p.items, p.only_online
    FROM deliveries d JOIN packages p ON p.id = d.package_id
    WHERE d.status = 'queued' ORDER BY d.id LIMIT 3
  `);
  const deliveries = [];
  for (const r of rows) {
    await db.run("UPDATE deliveries SET status = 'inflight', claimed_at = ? WHERE id = ?",
      [db.now(), r.id]);
    deliveries.push({
      id: r.id, uuid: r.uuid,
      pkg: {
        name: r.name, msg: withFooter(r.message, r.uuid),
        items: JSON.parse(r.items), oo: r.only_online ? 1 : 0,
      },
    });
  }

  res.json({ lookups, deliveries });
}));

// Results: delivery outcomes and lookup answers.
router.post('/report', wrap(async (req, res) => {
  const { deliveries, lookups } = req.body || {};
  if (Array.isArray(deliveries)) {
    for (const d of deliveries) {
      if (!d || !Number.isInteger(d.id)) continue;
      const status = ['sent', 'failed', 'skipped'].includes(d.status) ? d.status : 'sent';
      await db.run('UPDATE deliveries SET status = ?, sent_at = ? WHERE id = ?',
        [status, db.now(), d.id]);
    }
  }
  if (Array.isArray(lookups)) {
    for (const l of lookups) {
      if (!l || !Number.isInteger(l.id)) continue;
      const row = await db.get('SELECT * FROM lookups WHERE id = ?', [l.id]);
      if (!row || row.status !== 'pending') continue;
      if (row.kind === 'name2key' && typeof l.uuid === 'string' && UUID_RE.test(l.uuid)) {
        await db.run(`
          INSERT INTO subscribers (uuid, name, source, created_at) VALUES (?, ?, 'admin', ?)
          ON CONFLICT (uuid) DO UPDATE SET active = 1
        `, [l.uuid.toLowerCase(), row.query, db.now()]);
        await db.run("UPDATE lookups SET status = 'done' WHERE id = ?", [l.id]);
      } else if (row.kind === 'key2name' && typeof l.name === 'string' && l.name.length > 0) {
        await db.run('UPDATE subscribers SET name = ? WHERE uuid = ?', [l.name, row.query]);
        await db.run("UPDATE lookups SET status = 'done' WHERE id = ?", [l.id]);
      } else {
        await db.run("UPDATE lookups SET status = 'notfound' WHERE id = ?", [l.id]);
        if (row.kind === 'key2name') {
          // Leave the subscriber with the raw UUID visible as its name.
          await db.run("UPDATE subscribers SET name = ? WHERE uuid = ? AND name = '(resolving...)'",
            [row.query, row.query]);
        }
      }
    }
  }
  await touchKiosk();
  res.json({ ok: true });
}));

// In-world subscribe/unsubscribe touches.
router.post('/event', wrap(async (req, res) => {
  const { type, uuid, name } = req.body || {};
  if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) {
    return res.status(400).json({ error: 'bad uuid' });
  }
  const u = uuid.toLowerCase();
  if (type === 'sub') {
    await db.run(`
      INSERT INTO subscribers (uuid, name, source, created_at) VALUES (?, ?, 'kiosk', ?)
      ON CONFLICT (uuid) DO UPDATE SET active = 1, name = EXCLUDED.name
    `, [u, typeof name === 'string' && name ? name : u, db.now()]);
    // Optional list choice made at the kiosk's subscribe dialog.
    const listName = String((req.body && req.body.list) || '').trim();
    if (listName) {
      const l = await db.get('SELECT id FROM lists WHERE LOWER(name) = LOWER(?)', [listName]);
      if (l) {
        await db.run(
          'INSERT INTO list_members (list_id, uuid) VALUES (?, ?) ON CONFLICT (list_id, uuid) DO NOTHING',
          [l.id, u]);
      }
    }
  } else if (type === 'unsub') {
    await db.run('UPDATE subscribers SET active = 0 WHERE uuid = ?', [u]);
  } else {
    return res.status(400).json({ error: 'bad type' });
  }
  await touchKiosk();
  res.json({ ok: true });
}));

// Redelivery: latest package for one avatar (logged as a delivery).
router.get('/latest', wrap(async (req, res) => {
  const uuid = String(req.query.uuid || '').toLowerCase();
  const pkg = await latestPackage();
  if (!pkg) return res.json({ latest: null });
  if (UUID_RE.test(uuid)) {
    // Shadow-banned avatars get a plausible "nothing published yet" —
    // indistinguishable from an empty newsletter on their side.
    const sub = await db.get('SELECT shadowbanned FROM subscribers WHERE uuid = ?', [uuid]);
    if (sub && sub.shadowbanned) {
      await touchKiosk();
      return res.json({ latest: null });
    }
    await db.run(`
      INSERT INTO deliveries (package_id, uuid, status, queued_at, sent_at)
      VALUES (?, ?, 'sent', ?, ?)
    `, [pkg.id, uuid, db.now(), db.now()]);
    pkg.msg = withFooter(pkg.msg, uuid);
  }
  await touchKiosk();
  res.json({ latest: pkg });
}));

module.exports = { router, pingKiosk, kioskOnline, kioskRow, UUID_RE, wrap, fireDueSchedules };
