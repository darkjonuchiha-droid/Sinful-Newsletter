'use strict';
/* ============================================================
   Offline demo harness for the Sinful Newsletter Hub UI.

   Intercepts window.fetch and answers every /api/* call with
   realistic sample data, so demo.html can be opened straight
   from disk (double-click) with no server, database or kiosk.

   Nothing here ships to production — it exists purely so the
   interface can be explored and restyled. Mutations are
   simulated in memory: sends, edits, list changes and toggles
   all update the demo data and re-render like the real thing.

   Add ?login to the URL to start on the login screen instead
   (password: anything).
   ============================================================ */

(() => {
  const startLoggedOut = location.search.includes('login');
  let loggedIn = !startLoggedOut;

  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const HOUR = 3600e3, DAY = 24 * HOUR;

  // ---------- sample data ----------

  const db = {
    subscribers: [
      { uuid: '4eebe02d-2827-4f71-a25d-d6eed9486a10', display_name: 'Jon Heartsong', name: 'Lelouch Resident', active: 1, shadowbanned: 0, source: 'admin', created_at: iso(30 * DAY) },
      { uuid: 'a1b2c3d4-1111-4111-8111-111111111111', display_name: 'ʟᴇɴᴀ', name: 'Elenique Resident', active: 1, shadowbanned: 0, source: 'Beach Board', created_at: iso(12 * DAY) },
      { uuid: 'b2c3d4e5-2222-4222-8222-222222222222', display_name: 'Zelda', name: 'Zelda1985 Resident', active: 1, shadowbanned: 0, source: 'kiosk', created_at: iso(9 * DAY) },
      { uuid: 'c3d4e5f6-3333-4333-8333-333333333333', display_name: 'Calista Tutti', name: 'Calista Tutti', active: 1, shadowbanned: 0, source: 'kiosk', created_at: iso(8 * DAY) },
      { uuid: 'd4e5f6a7-4444-4444-8444-444444444444', display_name: '✧ Sïnful Røse ✧', name: 'Rosalind Nightfall', active: 1, shadowbanned: 0, source: 'Club Foyer', created_at: iso(6 * DAY) },
      { uuid: 'e5f6a7b8-5555-4555-8555-555555555555', display_name: 'Vic Aria', name: 'Vic Aria', active: 1, shadowbanned: 0, source: 'admin', created_at: iso(5 * DAY) },
      { uuid: 'f6a7b8c9-6666-4666-8666-666666666666', display_name: 'Eylris', name: 'Eylris', active: 1, shadowbanned: 0, source: 'kiosk', created_at: iso(4 * DAY) },
      { uuid: '07b8c9da-7777-4777-8777-777777777777', display_name: 'Marcus Vale', name: 'Marcus Vale', active: 0, shadowbanned: 0, source: 'kiosk', created_at: iso(3 * DAY) },
      { uuid: '18c9dae1-8888-4888-8888-888888888888', display_name: 'ᴅᴀʀᴋ ᴡᴏʟꜰ', name: 'Darkwolf Resident', active: 1, shadowbanned: 1, source: 'Beach Board', created_at: iso(2 * DAY) },
      { uuid: '29dae1f2-9999-4999-8999-999999999999', display_name: 'Nyx', name: 'Nyxandra Resident', active: 1, shadowbanned: 0, source: 'Mall Kiosk', created_at: iso(1 * DAY) },
    ],
    lists: [
      { id: 1, name: 'Orgy Nights', members: 6 },
      { id: 2, name: 'Concerts', members: 4 },
      { id: 3, name: 'Beach Events', members: 3 },
    ],
    members: { // list_id -> uuids
      1: ['4eebe02d-2827-4f71-a25d-d6eed9486a10', 'a1b2c3d4-1111-4111-8111-111111111111', 'b2c3d4e5-2222-4222-8222-222222222222', 'd4e5f6a7-4444-4444-8444-444444444444', 'e5f6a7b8-5555-4555-8555-555555555555', '29dae1f2-9999-4999-8999-999999999999'],
      2: ['4eebe02d-2827-4f71-a25d-d6eed9486a10', 'c3d4e5f6-3333-4333-8333-333333333333', 'f6a7b8c9-6666-4666-8666-666666666666', 'e5f6a7b8-5555-4555-8555-555555555555'],
      3: ['a1b2c3d4-1111-4111-8111-111111111111', 'd4e5f6a7-4444-4444-8444-444444444444', '29dae1f2-9999-4999-8999-999999999999'],
    },
    packages: [
      { id: 4, name: 'Midnight Masquerade — Invitation', message: 'Masks on, inhibitions off. Doors at 8pm SLT this Saturday at Sinful Isle.\n\nWear the enclosed invitation and touch it to unwrap your landmark, dress code card and a little gift.', items: ['Aphrodisia Masquerade Invitation'], only_online: 0, is_public: 1, pickup_lists: [], created_at: iso(2 * HOUR), updated_at: iso(2 * HOUR) },
      { id: 3, name: 'VIP — Private Afterparty', message: 'Just for our inner circle. Landmark inside; please don\'t reshare.', items: ['VIP Loft LM', 'Afterparty Rules'], only_online: 0, is_public: 0, pickup_lists: [{ id: 1, name: 'Orgy Nights' }], created_at: iso(2 * DAY), updated_at: iso(2 * DAY) },
      { id: 2, name: 'Summer Sunday Orgy', message: 'Join us for a chill morning of Sunday debauchery and pleasure.', items: ['Sunday LM', 'Sinful Gift Box'], only_online: 1, is_public: 1, pickup_lists: [], created_at: iso(6 * DAY), updated_at: iso(6 * DAY) },
      { id: 1, name: 'Weekly Notice — Schedule', message: 'This week at Sinful: Thursday DJ night, Friday latex social, Sunday morning orgy. Landmarks enclosed.', items: ['Club LM', 'Weekly Schedule Notecard', 'Missing Gift Box'], only_online: 0, is_public: 0, pickup_lists: [], created_at: iso(9 * DAY), updated_at: iso(9 * DAY) },
    ],
    stats: {
      4: { pending: 3, sent: 6, skipped: 0, failed: 0, reached: 6, audiences: ['All subscribers'] },
      3: { pending: 0, sent: 4, skipped: 0, failed: 0, reached: 4, audiences: ['Orgy Nights'] },
      2: { pending: 0, sent: 5, skipped: 3, failed: 1, reached: 5, audiences: ['All subscribers', 'Beach Events'] },
      1: { pending: 0, sent: 9, skipped: 0, failed: 0, reached: 8, audiences: ['All subscribers', 'Concerts'] },
    },
    schedules: [
      { id: 3, package_id: 4, list_id: 0, send_at: iso(-2 * DAY), status: 'pending', fired_at: null, name: 'Midnight Masquerade — Invitation', list_name: null },
      { id: 2, package_id: 3, list_id: 1, send_at: iso(-5 * DAY), status: 'pending', fired_at: null, name: 'VIP — Private Afterparty', list_name: 'Orgy Nights' },
      { id: 1, package_id: 2, list_id: 0, send_at: iso(6 * DAY), status: 'sent', fired_at: iso(6 * DAY), name: 'Summer Sunday Orgy', list_name: null },
    ],
    kiosk: {
      online: true,
      lastSeen: iso(90e3),
      inventory: [
        { name: 'Aphrodisia Masquerade Invitation', type: 'object', ok: 1 },
        { name: 'Sinful Gift Box', type: 'object', ok: 1 },
        { name: 'Rare Statue (no transfer)', type: 'object', ok: 0 },
        { name: 'Club LM', type: 'landmark', ok: 1 },
        { name: 'Sunday LM', type: 'landmark', ok: 1 },
        { name: 'VIP Loft LM', type: 'landmark', ok: 1 },
        { name: 'Beach LM', type: 'landmark', ok: 1 },
        { name: 'Weekly Schedule Notecard', type: 'notecard', ok: 1 },
        { name: 'Afterparty Rules', type: 'notecard', ok: 1 },
        { name: 'Dress Code', type: 'notecard', ok: 1 },
        { name: 'Sinful Anthem', type: 'sound', ok: 1 },
      ],
    },
    satellites: [
      { label: 'Beach Board', region: 'Sinful Isle', list: 'Beach Events', online: true, lastSeen: iso(120e3) },
      { label: 'Club Foyer', region: 'Sinful Isle', list: '', online: true, lastSeen: iso(200e3) },
      { label: 'Mall Kiosk', region: 'Bellisseria Market', list: 'Concerts', online: false, lastSeen: iso(3 * HOUR) },
    ],
    deliveries: {
      4: [
        { id: 106, uuid: '29dae1f2-9999-4999-8999-999999999999', status: 'queued', queued_at: iso(4 * 60e3), sent_at: null, name: 'Nyxandra Resident' },
        { id: 105, uuid: 'f6a7b8c9-6666-4666-8666-666666666666', status: 'queued', queued_at: iso(4 * 60e3), sent_at: null, name: 'Eylris' },
        { id: 104, uuid: 'e5f6a7b8-5555-4555-8555-555555555555', status: 'inflight', queued_at: iso(4 * 60e3), sent_at: null, name: 'Vic Aria' },
        { id: 103, uuid: 'd4e5f6a7-4444-4444-8444-444444444444', status: 'sent', queued_at: iso(4 * 60e3), sent_at: iso(2 * 60e3), name: 'Rosalind Nightfall' },
        { id: 102, uuid: 'c3d4e5f6-3333-4333-8333-333333333333', status: 'sent', queued_at: iso(4 * 60e3), sent_at: iso(2 * 60e3), name: 'Calista Tutti' },
        { id: 101, uuid: '4eebe02d-2827-4f71-a25d-d6eed9486a10', status: 'sent', queued_at: iso(4 * 60e3), sent_at: iso(3 * 60e3), name: 'Lelouch Resident' },
      ],
      2: [
        { id: 55, uuid: '07b8c9da-7777-4777-8777-777777777777', status: 'skipped', queued_at: iso(6 * DAY), sent_at: iso(6 * DAY), name: 'Marcus Vale' },
        { id: 54, uuid: 'b2c3d4e5-2222-4222-8222-222222222222', status: 'failed', queued_at: iso(6 * DAY), sent_at: iso(6 * DAY), name: 'Zelda1985 Resident' },
        { id: 53, uuid: '4eebe02d-2827-4f71-a25d-d6eed9486a10', status: 'sent', queued_at: iso(6 * DAY), sent_at: iso(6 * DAY), name: 'Lelouch Resident' },
      ],
    },
  };

  const audiencesOf = (pkgId) => {
    const names = (db.stats[pkgId] || {}).audiences || [];
    return names.map(n => n === 'All subscribers'
      ? { list_id: 0, name: n }
      : { list_id: (db.lists.find(l => l.name === n) || { id: -1 }).id, name: n });
  };

  const listsFor = (uuid) => db.lists
    .filter(l => (db.members[l.id] || []).includes(uuid))
    .map(l => ({ id: l.id, name: l.name }));

  const refreshListCounts = () => db.lists.forEach(l => {
    l.members = (db.members[l.id] || []).length;
  });

  // ---------- fake API ----------

  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });

  function handle(method, path, query, body) {
    // --- session ---
    if (path === '/api/login') { loggedIn = true; return json({ ok: true }); }
    if (path === '/api/logout') { loggedIn = false; return json({ ok: true }); }
    if (!loggedIn) return json({ error: 'not logged in' }, 401);

    // --- read ---
    if (path === '/api/overview') {
      return json({
        subscribers: db.subscribers.filter(s => s.active).length,
        inactive: db.subscribers.filter(s => !s.active).length,
        packages: db.packages.length,
        kioskOnline: db.kiosk.online,
        kioskLastSeen: db.kiosk.lastSeen,
        satellites: db.satellites,
        pendingLookups: [{ id: 1, kind: 'name2key', query: 'Aria Sinclair' }],
        sending: db.packages.filter(p => (db.stats[p.id] || {}).pending)
          .map(p => ({ id: p.id, name: p.name, ...db.stats[p.id] })),
      });
    }
    if (path === '/api/kiosk-status') return json(db.kiosk);
    if (path === '/api/lists') {
      refreshListCounts();
      return json({
        lists: db.lists,
        special: [
          { id: -1, name: 'Shadow-banned', icon: '👻', members: db.subscribers.filter(s => s.shadowbanned).length },
          { id: -2, name: 'Inactive', icon: '💤', members: db.subscribers.filter(s => !s.active).length },
        ],
      });
    }
    if (path === '/api/subscribers' && method === 'GET') {
      const q = (query.get('q') || '').toLowerCase();
      const list = Number(query.get('list')) || 0;
      let rows = db.subscribers.slice();
      if (list === -1) rows = rows.filter(s => s.shadowbanned);
      else if (list === -2) rows = rows.filter(s => !s.active);
      else if (list > 0) rows = rows.filter(s => (db.members[list] || []).includes(s.uuid));
      if (q) rows = rows.filter(s => (s.display_name + ' ' + s.name + ' ' + s.uuid).toLowerCase().includes(q));
      rows.sort((a, b) => (a.display_name || a.name).localeCompare(b.display_name || b.name));
      return json({ subscribers: rows.map(s => ({ ...s, lists: listsFor(s.uuid) })) });
    }
    if (path === '/api/packages' && method === 'GET') {
      return json({ packages: db.packages.map(p => ({ ...p, stats: db.stats[p.id] || { pending: 0, sent: 0, skipped: 0, failed: 0, reached: 0, audiences: [] } })) });
    }
    if (path === '/api/schedules') return json({ schedules: db.schedules });
    if (path === '/api/deliveries') {
      const pid = Number(query.get('package_id'));
      return json({
        deliveries: db.deliveries[pid] || [],
        stats: db.stats[pid] || { pending: 0, sent: 0, skipped: 0, failed: 0 },
        audiences: audiencesOf(pid),
      });
    }

    // --- writes (simulated) ---
    let m;
    if ((m = path.match(/^\/api\/packages\/(\d+)\/send$/))) {
      const pid = Number(m[1]);
      const st = db.stats[pid] = db.stats[pid] || { pending: 0, sent: 0, skipped: 0, failed: 0, reached: 0, audiences: [] };
      const ids = (body.list_ids || []).length ? body.list_ids : [0];
      let queued = 0;
      for (const lid of ids) {
        const name = lid === 0 ? 'All subscribers'
          : lid === -1 ? 'Shadow-banned' : lid === -2 ? 'Inactive'
            : (db.lists.find(l => l.id === lid) || {}).name;
        if (name && !st.audiences.includes(name)) st.audiences.push(name);
        queued += lid === 0 ? db.subscribers.filter(s => s.active && !s.shadowbanned).length
          : lid < 0 ? db.subscribers.filter(s => lid === -1 ? s.shadowbanned : !s.active).length
            : (db.members[lid] || []).length;
      }
      st.pending += queued;
      return json({ ok: true, queued, kioskOnline: db.kiosk.online });
    }
    if ((m = path.match(/^\/api\/packages\/(\d+)\/sendto$/))) {
      const st = db.stats[Number(m[1])];
      if (st) st.pending += 1;
      return json({ ok: true, kioskOnline: db.kiosk.online });
    }
    if ((m = path.match(/^\/api\/packages\/(\d+)\/schedule$/))) {
      const pid = Number(m[1]);
      const pkg = db.packages.find(p => p.id === pid);
      const lid = Number(body.list_id) || 0;
      db.schedules.unshift({
        id: Math.max(0, ...db.schedules.map(s => s.id)) + 1,
        package_id: pid, list_id: lid, send_at: body.send_at, status: 'pending', fired_at: null,
        name: pkg ? pkg.name : 'Package',
        list_name: lid === 0 ? null : lid === -1 ? 'Shadow-banned' : lid === -2 ? 'Inactive'
          : (db.lists.find(l => l.id === lid) || {}).name,
      });
      return json({ ok: true, id: 99 });
    }
    if ((m = path.match(/^\/api\/schedules\/(\d+)$/)) && method === 'DELETE') {
      const s = db.schedules.find(x => x.id === Number(m[1]));
      if (s) s.status = 'cancelled';
      return json({ ok: true });
    }
    if (path === '/api/packages' && method === 'POST') {
      const id = Math.max(0, ...db.packages.map(p => p.id)) + 1;
      db.packages.unshift({
        id, name: body.name, message: body.message, items: body.items || [],
        only_online: body.only_online ? 1 : 0, is_public: body.is_public === false ? 0 : 1,
        pickup_lists: (body.pickup_lists || []).map(lid =>
          db.lists.find(l => l.id === lid)).filter(Boolean).map(l => ({ id: l.id, name: l.name })),
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      db.stats[id] = { pending: 0, sent: 0, skipped: 0, failed: 0, reached: 0, audiences: [] };
      return json({ ok: true, id });
    }
    if ((m = path.match(/^\/api\/packages\/(\d+)$/))) {
      const pid = Number(m[1]);
      if (method === 'PUT') {
        const p = db.packages.find(x => x.id === pid);
        if (p) Object.assign(p, {
          name: body.name, message: body.message, items: body.items || [],
          only_online: body.only_online ? 1 : 0, is_public: body.is_public === false ? 0 : 1,
          pickup_lists: (body.pickup_lists || []).map(lid =>
            db.lists.find(l => l.id === lid)).filter(Boolean).map(l => ({ id: l.id, name: l.name })),
          updated_at: new Date().toISOString(),
        });
        return json({ ok: true });
      }
      if (method === 'DELETE') {
        db.packages = db.packages.filter(x => x.id !== pid);
        return json({ ok: true });
      }
    }
    if (path === '/api/lists' && method === 'POST') {
      const id = Math.max(0, ...db.lists.map(l => l.id)) + 1;
      db.lists.push({ id, name: body.name, members: 0 });
      db.members[id] = [];
      return json({ ok: true, id });
    }
    if ((m = path.match(/^\/api\/lists\/(\d+)$/)) && method === 'DELETE') {
      const lid = Number(m[1]);
      db.lists = db.lists.filter(l => l.id !== lid);
      delete db.members[lid];
      return json({ ok: true });
    }
    if ((m = path.match(/^\/api\/lists\/(\d+)\/members$/)) && method === 'POST') {
      const lid = Number(m[1]);
      db.members[lid] = db.members[lid] || [];
      if (!db.members[lid].includes(body.uuid)) db.members[lid].push(body.uuid);
      return json({ ok: true });
    }
    if ((m = path.match(/^\/api\/lists\/(\d+)\/members\/([0-9a-f-]+)$/)) && method === 'DELETE') {
      const lid = Number(m[1]);
      db.members[lid] = (db.members[lid] || []).filter(u => u !== m[2]);
      return json({ ok: true });
    }
    if (path === '/api/subscribers' && method === 'POST') {
      return json({ ok: true, note: 'looking up name via kiosk — appears once resolved' });
    }
    if (path === '/api/subscribers/refresh-display') {
      return json({ ok: true, queued: db.subscribers.length });
    }
    if (path === '/api/subscribers/bulk') {
      const set = new Set(body.uuids || []);
      let affected = 0;
      for (const s of db.subscribers) {
        if (!set.has(s.uuid)) continue;
        affected++;
        if (body.action === 'activate') s.active = 1;
        if (body.action === 'deactivate') s.active = 0;
        if (body.action === 'shadowban') s.shadowbanned = 1;
        if (body.action === 'unshadowban') s.shadowbanned = 0;
        if (body.action === 'addlist') {
          const l = db.members[body.list_id] = db.members[body.list_id] || [];
          if (!l.includes(s.uuid)) l.push(s.uuid);
        }
        if (body.action === 'removelist') {
          db.members[body.list_id] = (db.members[body.list_id] || []).filter(u => u !== s.uuid);
        }
      }
      if (body.action === 'delete') db.subscribers = db.subscribers.filter(s => !set.has(s.uuid));
      return json({ ok: true, affected });
    }
    if ((m = path.match(/^\/api\/subscribers\/([0-9a-f-]+)$/))) {
      const s = db.subscribers.find(x => x.uuid === m[1]);
      if (method === 'PATCH' && s) {
        if ('active' in body) s.active = body.active ? 1 : 0;
        if ('shadowbanned' in body) s.shadowbanned = body.shadowbanned ? 1 : 0;
        return json({ ok: true });
      }
      if (method === 'DELETE') {
        db.subscribers = db.subscribers.filter(x => x.uuid !== m[1]);
        return json({ ok: true });
      }
    }

    return json({ error: 'not found in demo harness: ' + method + ' ' + path }, 404);
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.includes('/api/')) return realFetch(input, init);
    const u = new URL(url, location.href);
    const method = (init.method || 'GET').toUpperCase();
    let body = {};
    try { body = init.body ? JSON.parse(init.body) : {}; } catch { /* ignore */ }
    await new Promise(r => setTimeout(r, 90)); // a touch of latency, like the real thing
    return handle(method, u.pathname.replace(/\/+$/, ''), u.searchParams, body);
  };

  console.info('%cSinful Newsletter — offline design demo',
    'color:#ff3d6e;font-weight:bold', '\nSample data only; no server required.');
})();
