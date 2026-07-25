'use strict';
/* Sinful Newsletter Hub — admin SPA (vanilla, no build step) */

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  packages: [],
  subscribers: [],
  schedules: [],
  lists: [],
  filterList: 0,      // 0 = all subscribers
  memberSub: null,    // subscriber shown in the membership modal
  selected: new Set(), // uuids ticked for bulk actions
  kiosk: { online: false, inventory: [] },
  overview: null,
  editing: null,      // null | {id?} package being edited
  editItems: new Set,
  scheduling: null,   // package id being scheduled
  calMonth: null,     // Date at the 1st of the displayed month
  pollTimer: null,
};

// SL advertises event times in SLT (Pacific). Show both to avoid mistakes.
const fmtLocal = (iso) => new Date(iso).toLocaleString([], {
  weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
});
const fmtSLT = (iso) => new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  weekday: 'short', hour: 'numeric', minute: '2-digit',
}).format(new Date(iso));

// ---------------- api ----------------

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && path !== '/login') {
    showLogin();
    throw new Error('session expired');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.data = data;
    throw err;
  }
  return data;
}

// Send a package to one recipient; if they're shadow-banned, ask before
// overriding. Returns true when a delivery was queued.
async function trySendTo(pkgId, input) {
  try {
    await api(`/packages/${pkgId}/sendto`, { method: 'POST', body: { input } });
    return true;
  } catch (err) {
    if (err.data && err.data.shadowbanned) {
      const ok = await confirmModal(
        `👻 ${err.data.name} is shadow-banned and excluded from all sends. Deliver to them anyway?`);
      if (!ok) return false;
      await api(`/packages/${pkgId}/sendto`, { method: 'POST', body: { input, force: true } });
      return true;
    }
    throw err;
  }
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

// ---------------- views ----------------

function showLogin() {
  clearInterval(state.pollTimer);
  $('#view-app').classList.add('hidden');
  $('#view-login').classList.remove('hidden');
  $('#login-password').focus();
}

async function showApp() {
  $('#view-login').classList.add('hidden');
  $('#view-app').classList.remove('hidden');
  await refreshAll();
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(pollTick, 5000);
}

async function refreshAll() {
  await Promise.all([loadOverview(), loadPackages(), loadSubscribers(), loadKiosk(),
    loadSchedules(), loadLists()]);
}

async function pollTick() {
  try {
    await loadOverview();
    // While a blast is running, keep package stats live.
    if (state.overview && state.overview.sending.length) await loadPackages();
    // Keep schedule state fresh whenever any are pending.
    if (state.schedules.some(s => s.status === 'pending')) await loadSchedules();
  } catch { /* transient */ }
}

// ---------------- overview / kiosk pill ----------------

async function loadOverview() {
  const prevPending = state.overview ? state.overview.pendingLookups.length : 0;
  state.overview = await api('/overview');
  const { kioskOnline, kioskLastSeen, pendingLookups, subscribers } = state.overview;
  // A name lookup just resolved in-world — show the new subscriber(s) now.
  if (prevPending > 0 && pendingLookups.length < prevPending) loadSubscribers();
  const pill = $('#kiosk-pill');
  pill.classList.toggle('pill-on', kioskOnline);
  pill.classList.toggle('pill-off', !kioskOnline);
  const satellites = state.overview.satellites || [];
  const satsUp = satellites.filter(s => s.online).length;
  $('#kiosk-pill-text').textContent = (kioskOnline ? 'kiosk online' : 'kiosk offline')
    + (satellites.length ? ` · ${satsUp}/${satellites.length} sat` : '');
  pill.title = (kioskLastSeen ? `Primary last seen (UTC): ${kioskLastSeen}` : 'Kiosk has never connected')
    + satellites.map(s => `\n${s.online ? '🟢' : '🔴'} ${s.label} — ${s.region || '?'}`
      + (s.list ? ` → list "${s.list}"` : '')).join('');
  $('#sub-count').textContent = subscribers;
  renderPendingLookups(pendingLookups);
}

function renderPendingLookups(lookups) {
  const wrap = $('#pending-lookups');
  const names = lookups.filter(l => l.kind === 'name2key');
  wrap.classList.toggle('hidden', names.length === 0);
  wrap.innerHTML = names.map(l =>
    `<span class="lookup-chip" title="Waiting for the in-world kiosk to resolve this name">${esc(l.query)}</span>`
  ).join('');
}

// ---------------- packages ----------------

async function loadPackages() {
  const [pk, kiosk] = await Promise.all([api('/packages'), api('/kiosk-status')]);
  state.packages = pk.packages;
  state.kiosk = kiosk;
  renderPackages();
}

function renderPackages() {
  const list = $('#package-list');
  const invNames = new Set(state.kiosk.inventory.map(i => i.name));
  $('#packages-empty').classList.toggle('hidden', state.packages.length > 0);
  list.innerHTML = state.packages.map(p => {
    const stats = p.stats || {};
    const pending = stats.pending || 0, sent = stats.sent || 0, failed = stats.failed || 0;
    const skipped = stats.skipped || 0;
    const total = pending + sent + failed + skipped;
    let chips = p.items.map(name =>
      `<span class="item-chip ${invNames.has(name) ? '' : 'missing'}"
             title="${invNames.has(name) ? '' : 'No longer in the kiosk inventory!'}">${esc(name)}</span>`
    ).join('') || '<span class="item-chip">message only</span>';
    if (p.only_online) {
      chips = `<span class="item-chip oo-chip" title="Delivered only to subscribers in-world at send time">🟢 online only</span>` + chips;
    }
    const progress = pending > 0 && total > 0
      ? `<div class="progress"><div style="width:${Math.round(100 * (sent + skipped) / total)}%"></div></div>` : '';
    return `
      <article class="pkg-card" data-id="${p.id}">
        <div class="pkg-top">
          <h3 class="pkg-name">${esc(p.name)}</h3>
          <span class="pkg-date">created ${esc((p.created_at || '').slice(0, 16).replace('T', ' '))} UTC</span>
        </div>
        <p class="pkg-msg">${esc(p.message || '(no message)')}</p>
        <div class="pkg-items">${chips}</div>
        ${progress}
        <div class="pkg-foot">
          <div class="pkg-stats">
            <span>sent <b>${sent}</b></span>
            <span title="Distinct subscribers who received it at least once">reached <b>${stats.reached || 0}</b></span>
            <span class="stat-pending">pending <b>${pending}</b></span>
            ${skipped ? `<span>skipped <b>${skipped}</b></span>` : ''}
            <span class="stat-failed">failed <b>${failed}</b></span>
            ${(stats.audiences || []).length
              ? `<span class="pkg-audiences" title="Audiences this package was sent to">via ${esc(stats.audiences.join(', '))}</span>` : ''}
          </div>
          <div class="pkg-actions">
            <div class="dropdown">
              <button class="btn btn-primary btn-mini" data-act="sendmenu">Send ▾</button>
              <div class="drop-menu hidden">
                <button data-act="send">Send to all</button>
                <button data-act="sendlist">Send to list…</button>
                <button data-act="test">Send to one…</button>
              </div>
            </div>
            <button class="btn btn-ghost btn-mini" data-act="schedule">Schedule…</button>
            <button class="btn btn-ghost btn-mini" data-act="log">Log</button>
            <button class="btn btn-ghost btn-mini" data-act="edit">Edit</button>
            <button class="btn btn-ghost btn-mini" data-act="delete">Delete</button>
          </div>
        </div>
      </article>`;
  }).join('');
}

function closeSendMenus(except) {
  document.querySelectorAll('.drop-menu').forEach(m => {
    if (m !== except) m.classList.add('hidden');
  });
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.dropdown')) closeSendMenus();
});

$('#package-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.closest('.pkg-card').dataset.id);
  const pkg = state.packages.find(p => p.id === id);
  if (!pkg) return;
  const act = btn.dataset.act;

  if (act === 'sendmenu') {
    const menu = btn.parentElement.querySelector('.drop-menu');
    closeSendMenus(menu);
    menu.classList.toggle('hidden');
    return;
  }
  closeSendMenus();

  if (act === 'edit') return openEditor(pkg);
  if (act === 'schedule') return openSchedule(pkg);
  if (act === 'sendlist') return openSendList(pkg);
  if (act === 'log') return openLog(pkg);

  if (act === 'delete') {
    if (!await confirmModal(`Delete package “${pkg.name}”? Its delivery history is removed too.`)) return;
    await api(`/packages/${id}`, { method: 'DELETE' });
    toast('Package deleted', 'ok');
    return loadPackages();
  }

  if (act === 'send') {
    const n = state.overview ? state.overview.subscribers : '?';
    const offlineNote = state.kiosk.online ? '' :
      '\n⚠ The kiosk is OFFLINE — deliveries will queue up and go out when it reconnects.';
    if (!await confirmModal(`Send “${pkg.name}” to ${n} active subscribers?${offlineNote}`)) return;
    const r = await api(`/packages/${id}/send`, { method: 'POST', body: {} });
    toast(`Queued ${r.queued} deliveries`, 'ok');
    return loadPackages();
  }

  if (act === 'test') return openSendOne(pkg);
});

// ---------------- package editor ----------------

function openEditor(pkg) {
  state.editing = pkg ? { id: pkg.id } : {};
  state.editItems = new Set(pkg ? pkg.items : []);
  $('#editor-title').textContent = pkg ? 'Edit package' : 'New package';
  $('#pkg-name').value = pkg ? pkg.name : '';
  $('#pkg-message').value = pkg ? pkg.message : '';
  $('#pkg-oo').checked = !!(pkg && pkg.only_online);
  updateMsgCount();
  renderItemGrid();
  $('#editor-overlay').classList.remove('hidden');
  $('#pkg-name').focus();
}

// -- attachment picker: attached list + "Add attachment" category menu --

const TYPE_ICON = {
  landmark: '🗺️', notecard: '📄', object: '📦', texture: '🖼️',
  clothing: '👗', animation: '💃', gesture: '👋', sound: '🔊', item: '✨',
};
const ATTACH_CATS = [
  { key: 'landmark', label: 'Landmarks', icon: '🗺️' },
  { key: 'notecard', label: 'Notecards', icon: '📄' },
  { key: 'object', label: 'Objects', icon: '📦' },
  { key: 'other', label: 'Other', icon: '✨' },
];
const catOf = (type) => ['landmark', 'notecard', 'object'].includes(type) ? type : 'other';
const invItem = (name) => state.kiosk.inventory.find(i => i.name === name);

let attachCat = null; // null = category-selection view
let attachQ = '';

function renderItemGrid() { // kept name: called from openEditor
  const warn = $('#pkg-kiosk-warn');
  if (!state.kiosk.online) {
    warn.textContent = 'Kiosk is offline — this item list is from its last report and may be stale.';
    warn.classList.remove('hidden');
  } else warn.classList.add('hidden');
  attachCat = null;
  attachQ = '';
  $('#attach-search').value = '';
  renderAttached();
  renderAvail();
}

function renderAttached() {
  const box = $('#attached-list');
  $('#attach-count').textContent = state.editItems.size;
  if (!state.editItems.size) {
    box.innerHTML = '<p class="hint">Nothing yet — message-only package.</p>';
    return;
  }
  box.innerHTML = [...state.editItems].map(name => {
    const it = invItem(name);
    const missing = !it;
    const icon = missing ? '⚠️' : (TYPE_ICON[it.type] || '✨');
    return `<div class="attached-row ${missing ? 'missing' : ''}"
        title="${missing ? 'No longer in the kiosk — remove it or put the item back' : esc(it.type)}">
      <span>${icon} ${esc(name)}${missing ? ' <em>(not in kiosk!)</em>' : ''}</span>
      <button type="button" class="btn btn-ghost btn-mini" data-detach="${esc(name)}">✕</button>
    </div>`;
  }).join('');
}

$('#attached-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-detach]');
  if (!btn) return;
  state.editItems.delete(btn.dataset.detach);
  renderAttached();
  renderAvail();
});

function availableItems() {
  return state.kiosk.inventory.filter(i => !state.editItems.has(i.name));
}

function renderAvail() {
  const avail = availableItems();
  const search = $('#attach-search');

  // Step 1: pick a category.
  if (attachCat === null) {
    search.classList.add('hidden');
    $('#attach-filter').innerHTML = '';
    if (!state.kiosk.inventory.length) {
      $('#attach-avail').innerHTML = '<p class="sendone-empty">Kiosk reports no items yet — '
        + 'drop landmarks, notecards or objects into the kiosk prim in-world first.</p>';
      return;
    }
    $('#attach-avail').innerHTML = ATTACH_CATS.map(c => {
      const n = avail.filter(i => catOf(i.type) === c.key).length;
      return `<button type="button" data-attach-cat="${c.key}" ${n ? '' : 'disabled'}>
        <span>${c.icon} ${c.label}</span><span class="mono">${n}</span></button>`;
    }).join('');
    return;
  }

  // Step 2: that category's items, searchable.
  search.classList.remove('hidden');
  const def = ATTACH_CATS.find(c => c.key === attachCat);
  $('#attach-filter').innerHTML =
    `<button type="button" class="filter-chip" data-attach-back="1">‹ Categories</button>
     <span class="cat-label">${def.icon} ${def.label}</span>`;
  const q = attachQ.toLowerCase();
  const rows = avail
    .filter(i => catOf(i.type) === attachCat)
    .filter(i => !q || i.name.toLowerCase().includes(q))
    .map(i => {
      const blocked = !i.ok;
      return `<button type="button" data-additem="${esc(i.name)}" ${blocked ? 'disabled' : ''}
        title="${blocked ? 'Not copy+transfer — cannot be sent (it would be given away permanently)' : 'Click to attach'}">
        <span>${TYPE_ICON[i.type] || '✨'} ${esc(i.name)}</span>
        ${blocked ? '<span class="mono">no-trans</span>' : ''}
      </button>`;
    });
  $('#attach-avail').innerHTML = rows.join('')
    || `<p class="sendone-empty">${q ? 'No items match the search.'
      : 'Everything in this category is already attached.'}</p>`;
}

$('#attach-filter').addEventListener('click', (e) => {
  if (!e.target.closest('button[data-attach-back]')) return;
  attachCat = null;
  attachQ = '';
  $('#attach-search').value = '';
  renderAvail();
});

$('#attach-search').addEventListener('input', () => {
  attachQ = $('#attach-search').value.trim();
  renderAvail();
});

$('#attach-avail').addEventListener('click', (e) => {
  const cat = e.target.closest('button[data-attach-cat]');
  if (cat) {
    attachCat = cat.dataset.attachCat;
    attachQ = '';
    $('#attach-search').value = '';
    return renderAvail();
  }
  const btn = e.target.closest('button[data-additem]');
  if (!btn) return;
  state.editItems.add(btn.dataset.additem);
  renderAttached();
  renderAvail(); // stays in the category for multi-add
});

function updateMsgCount() {
  $('#pkg-msg-count').textContent = `${$('#pkg-message').value.length} / 800`;
}
$('#pkg-message').addEventListener('input', updateMsgCount);

$('#btn-pkg-save').addEventListener('click', async () => {
  const body = {
    name: $('#pkg-name').value.trim(),
    message: $('#pkg-message').value.trim(),
    items: [...state.editItems],
    only_online: $('#pkg-oo').checked,
  };
  if (!body.name) return toast('Give the package a name', 'err');
  try {
    if (state.editing.id) await api(`/packages/${state.editing.id}`, { method: 'PUT', body });
    else await api('/packages', { method: 'POST', body });
    closeEditor();
    toast('Package saved', 'ok');
    loadPackages();
  } catch (err) { toast(err.message, 'err'); }
});

function closeEditor() {
  state.editing = null;
  $('#editor-overlay').classList.add('hidden');
}
$('#btn-pkg-cancel').addEventListener('click', closeEditor);
$('#btn-new-package').addEventListener('click', async () => {
  await loadKiosk();       // freshest possible item list
  openEditor(null);
});

// ---------------- subscribers ----------------

async function loadSubscribers() {
  const q = $('#sub-search').value.trim();
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (state.filterList) params.set('list', state.filterList);
  const qs = params.toString();
  const data = await api('/subscribers' + (qs ? `?${qs}` : ''));
  state.subscribers = data.subscribers;
  renderSubscribers();
}

function renderSubscribers() {
  // Drop selections that are no longer visible (filter/search changed).
  const visible = new Set(state.subscribers.map(s => s.uuid));
  for (const u of state.selected) if (!visible.has(u)) state.selected.delete(u);
  $('#sub-rows').innerHTML = state.subscribers.map(s => `
    <tr class="${s.active ? '' : 'inactive-row'}" data-uuid="${s.uuid}">
      <td><input type="checkbox" class="row-sel" ${state.selected.has(s.uuid) ? 'checked' : ''}></td>
      <td>${s.shadowbanned ? '<span title="Shadow-banned: looks subscribed to them, receives nothing">👻</span> ' : ''}${
        s.display_name ? esc(s.display_name)
          : '<span class="pending-disp" title="Waiting for the kiosk to resolve it">…</span>'}</td>
      <td>${esc(s.name)}</td>
      <td class="mono" title="${s.uuid}">${s.uuid}</td>
      <td>
        ${(s.lists || []).map(l => `<span class="sub-list-tag">${esc(l.name)}</span>`).join('')}
        <button class="btn btn-ghost btn-mini" data-act="lists" title="Edit list memberships">…</button>
      </td>
      <td><span class="src-tag">${esc(s.source)}</span></td>
      <td>
        <label class="toggle" title="${s.active ? 'Active — receives sends' : 'Inactive — skipped on sends'}">
          <input type="checkbox" data-act="toggle" ${s.active ? 'checked' : ''}><i></i>
        </label>
      </td>
      <td>
        <button class="btn btn-ghost btn-mini" data-act="shadow"
          title="${s.shadowbanned
            ? 'Shadow-banned — receives nothing. Click to lift.'
            : 'Shadow ban: they stay visibly subscribed but receive nothing'}">
          ${s.shadowbanned ? 'Lift 👻' : '👻'}</button>
        <button class="btn btn-ghost btn-mini" data-act="remove">Remove</button>
      </td>
    </tr>`).join('');
  renderBulkBar();
}

function renderBulkBar() {
  const n = state.selected.size;
  $('#bulk-bar').classList.toggle('hidden', n === 0);
  $('#bulk-count').textContent = `${n} selected`;
  const all = state.subscribers.length > 0 && n === state.subscribers.length;
  $('#sel-all').checked = all;
}

$('#sub-rows').addEventListener('click', async (e) => {
  const row = e.target.closest('tr[data-uuid]');
  if (!row) return;
  const uuid = row.dataset.uuid;
  const sub = state.subscribers.find(s => s.uuid === uuid);

  if (e.target.closest('button[data-act=lists]')) {
    return openMemberModal(sub);
  }
  if (e.target.closest('button[data-act=shadow]')) {
    if (!sub) return;
    try {
      await api(`/subscribers/${uuid}`, {
        method: 'PATCH', body: { shadowbanned: !sub.shadowbanned },
      });
      toast(sub.shadowbanned ? 'Shadow ban lifted' : 'Shadow-banned — they will notice nothing', 'ok');
      loadSubscribers();
    } catch (err) { toast(err.message, 'err'); }
    return;
  }
  if (e.target.closest('button[data-act=remove]')) {
    if (!await confirmModal(`Remove ${sub ? sub.name : uuid} permanently? (Use the Active toggle to pause instead.)`)) return;
    await api(`/subscribers/${uuid}`, { method: 'DELETE' });
    toast('Subscriber removed', 'ok');
    loadSubscribers();
    loadOverview();
    loadLists();
  }
});

$('#sub-rows').addEventListener('change', async (e) => {
  const cb = e.target.closest('input[data-act=toggle]');
  if (!cb) return;
  const uuid = cb.closest('tr').dataset.uuid;
  try {
    await api(`/subscribers/${uuid}`, { method: 'PATCH', body: { active: cb.checked } });
    loadSubscribers();
    loadOverview();
  } catch (err) { toast(err.message, 'err'); }
});

// -- bulk selection & actions --

$('#sub-rows').addEventListener('change', (e) => {
  const cb = e.target.closest('input.row-sel');
  if (!cb) return;
  const uuid = cb.closest('tr').dataset.uuid;
  if (cb.checked) state.selected.add(uuid);
  else state.selected.delete(uuid);
  renderBulkBar();
});

$('#sel-all').addEventListener('change', () => {
  if ($('#sel-all').checked) {
    for (const s of state.subscribers) state.selected.add(s.uuid);
  } else {
    state.selected.clear();
  }
  renderSubscribers();
});

async function runBulk(action, listId, label) {
  try {
    const r = await api('/subscribers/bulk', {
      method: 'POST',
      body: { action, uuids: [...state.selected], list_id: listId },
    });
    toast(`${label}: ${r.affected} subscriber(s)`, 'ok');
    state.selected.clear();
    loadSubscribers();
    loadLists();
    loadOverview();
  } catch (err) { toast(err.message, 'err'); }
}

let bulkListMode = null; // 'addlist' | 'removelist'

$('#bulk-bar').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-bulk]');
  if (!btn) return;
  const act = btn.dataset.bulk;
  const n = state.selected.size;
  if (act === 'clear') {
    state.selected.clear();
    return renderSubscribers();
  }
  if (act === 'activate') return runBulk('activate', 0, 'Activated');
  if (act === 'deactivate') return runBulk('deactivate', 0, 'Deactivated');
  if (act === 'shadowban') return runBulk('shadowban', 0, 'Shadow-banned');
  if (act === 'unshadowban') return runBulk('unshadowban', 0, 'Shadow ban lifted for');
  if (act === 'delete') {
    if (!await confirmModal(`Permanently remove ${n} subscriber(s)? (Deactivate instead if you just want to pause them.)`)) return;
    return runBulk('delete', 0, 'Removed');
  }
  if (act === 'addlist' || act === 'removelist') {
    if (!state.lists.length) return toast('Create a list first (the "+ New list" chip)', 'err');
    bulkListMode = act;
    $('#bulklist-title').textContent = act === 'addlist'
      ? `Add ${n} subscriber(s) to which list?`
      : `Remove ${n} subscriber(s) from which list?`;
    fillListSelect($('#bulklist-select'), false);
    $('#bulklist-overlay').classList.remove('hidden');
  }
});

$('#btn-bulklist-cancel').addEventListener('click', () =>
  $('#bulklist-overlay').classList.add('hidden'));

$('#btn-bulklist-go').addEventListener('click', () => {
  $('#bulklist-overlay').classList.add('hidden');
  const listId = Number($('#bulklist-select').value);
  if (!listId || !bulkListMode) return;
  const l = state.lists.find(x => x.id === listId);
  runBulk(bulkListMode, listId,
    bulkListMode === 'addlist' ? `Added to “${l.name}”` : `Removed from “${l.name}”`);
  bulkListMode = null;
});

$('#btn-sub-add').addEventListener('click', addSubscriber);
$('#sub-add-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addSubscriber(); });
async function addSubscriber() {
  const input = $('#sub-add-input').value.trim();
  if (!input) {
    toast('Type a UUID or legacy name in the box first, then press Add', 'err');
    $('#sub-add-input').focus();
    return;
  }
  try {
    const r = await api('/subscribers', { method: 'POST', body: { input } });
    toast(r.note || 'Added', 'ok');
    $('#sub-add-input').value = '';
    loadSubscribers();
    loadOverview();
  } catch (err) { toast(err.message, 'err'); }
}

$('#btn-refresh-disp').addEventListener('click', async () => {
  if (!await confirmModal('Re-fetch display names for all subscribers from the kiosk? '
    + 'They refresh over the next few minutes (touch the kiosk → Sync to hurry it).')) return;
  try {
    const r = await api('/subscribers/refresh-display', { method: 'POST', body: {} });
    toast(`Re-fetching ${r.queued} display name(s)`, 'ok');
    loadSubscribers();
  } catch (err) { toast(err.message, 'err'); }
});

let searchDebounce;
$('#sub-search').addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(loadSubscribers, 250);
});

// ---------------- kiosk ----------------

async function loadKiosk() {
  state.kiosk = await api('/kiosk-status');
}

// ---------------- lists ----------------

async function loadLists() {
  const data = await api('/lists');
  state.lists = data.lists;           // real lists (membership-editable)
  state.special = data.special || []; // system audiences (auto, negative ids)
  renderListChips();
}

// Real lists + system audiences, for send/schedule target pickers.
function allAudiences() {
  return state.lists.concat(state.special.map(s => ({
    id: s.id, name: `${s.icon} ${s.name}`, members: s.members,
  })));
}

function renderListChips() {
  const wrap = $('#list-chips');
  const chips = [
    `<button class="list-chip ${state.filterList === 0 ? 'active' : ''}" data-list="0">All subscribers</button>`,
  ].concat(state.lists.map(l =>
    `<button class="list-chip ${state.filterList === l.id ? 'active' : ''}" data-list="${l.id}">
       ${esc(l.name)}<span class="n">${l.members}</span>
     </button>`));
  chips.push('<button class="list-chip" data-newlist="1">+ New list</button>');
  // System audiences: maintained automatically, never offered at the kiosk.
  chips.push(...(state.special || []).map(s =>
    `<button class="list-chip special ${state.filterList === s.id ? 'active' : ''}"
       data-list="${s.id}" title="Automatic — everyone currently ${s.id === -1
         ? 'shadow-banned' : 'inactive'}. Not offered to subscribers at the kiosk.">
       ${s.icon} ${esc(s.name)}<span class="n">${s.members}</span>
     </button>`));
  if (state.filterList > 0) { // system audiences can't be deleted
    chips.push(`<button class="btn btn-ghost btn-mini" data-dellist="${state.filterList}">Delete this list</button>`);
  }
  wrap.innerHTML = chips.join('');
}

$('#list-chips').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-dellist]');
  if (del) {
    const l = state.lists.find(x => x.id === Number(del.dataset.dellist));
    if (!l) return;
    if (!await confirmModal(`Delete the list “${l.name}”? Subscribers themselves are kept — only the grouping is removed.`)) return;
    await api(`/lists/${l.id}`, { method: 'DELETE' });
    state.filterList = 0;
    toast('List deleted', 'ok');
    await loadLists();
    return loadSubscribers();
  }
  if (e.target.closest('[data-newlist]')) {
    const name = prompt('Name for the new list (max 20 characters):');
    if (!name || !name.trim()) return;
    try {
      await api('/lists', { method: 'POST', body: { name: name.trim() } });
      toast('List created', 'ok');
      loadLists();
    } catch (err) { toast(err.message, 'err'); }
    return;
  }
  const chip = e.target.closest('[data-list]');
  if (chip) {
    state.filterList = Number(chip.dataset.list);
    renderListChips();
    loadSubscribers();
  }
});

// -- membership modal --

function openMemberModal(sub) {
  if (!sub) return;
  // Only real lists here — system audiences follow the flags automatically.
  if (!state.lists.length) {
    return toast('Create a list first (the "+ New list" chip above the table)', 'err');
  }
  state.memberSub = sub;
  $('#member-title').textContent = `Lists for ${sub.name}:`;
  const memberOf = new Set((sub.lists || []).map(l => l.id));
  $('#member-checks').innerHTML = state.lists.map(l => `
    <label><input type="checkbox" data-list-id="${l.id}" ${memberOf.has(l.id) ? 'checked' : ''}>
      ${esc(l.name)}</label>`).join('');
  $('#member-overlay').classList.remove('hidden');
}

$('#member-checks').addEventListener('change', async (e) => {
  const cb = e.target.closest('input[data-list-id]');
  if (!cb || !state.memberSub) return;
  const listId = Number(cb.dataset.listId);
  try {
    if (cb.checked) {
      await api(`/lists/${listId}/members`, { method: 'POST', body: { uuid: state.memberSub.uuid } });
    } else {
      await api(`/lists/${listId}/members/${state.memberSub.uuid}`, { method: 'DELETE' });
    }
  } catch (err) {
    toast(err.message, 'err');
    cb.checked = !cb.checked;
  }
});

$('#btn-member-close').addEventListener('click', () => {
  state.memberSub = null;
  $('#member-overlay').classList.add('hidden');
  loadLists();
  loadSubscribers();
});

// -- send to one modal (subscriber search picker) --

const CLIENT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let sendOnePkg = null;
let sendOneDebounce;

function openSendOne(pkg) {
  sendOnePkg = pkg;
  $('#sendone-title').textContent = `Send “${pkg.name}” to one person:`;
  $('#sendone-search').value = '';
  $('#sendone-results').innerHTML = '';
  $('#sendone-overlay').classList.remove('hidden');
  $('#sendone-search').focus();
}

let sendOneSeq = 0;
async function renderSendOneResults(q) {
  const seq = ++sendOneSeq;
  if (!q) { $('#sendone-results').innerHTML = ''; return; } // blank until typed
  const data = await api('/subscribers' + (q ? `?q=${encodeURIComponent(q)}` : ''));
  if (seq !== sendOneSeq) return; // a newer search superseded this response
  const box = $('#sendone-results');
  const rows = data.subscribers.slice(0, 8).map(s => `
    <button data-sendone-uuid="${s.uuid}">
      <span>${s.shadowbanned ? '👻 ' : ''}${esc(s.display_name || s.name)}${
        s.display_name && s.display_name !== s.name ? ` <em class="mono">${esc(s.name)}</em>` : ''
      }${s.active ? '' : ' <em>(inactive)</em>'}</span>
      <span class="mono">${s.uuid.slice(0, 8)}…</span>
    </button>`);
  // Raw UUID pasted and not among the matches -> offer a direct send.
  if (CLIENT_UUID_RE.test(q.trim())
      && !data.subscribers.some(s => s.uuid === q.trim().toLowerCase())) {
    rows.push(`<button data-sendone-uuid="${esc(q.trim().toLowerCase())}">
      <span>Send to this UUID <em>(not a subscriber)</em></span>
      <span class="mono">${esc(q.trim().slice(0, 8))}…</span>
    </button>`);
  }
  box.innerHTML = rows.join('')
    || `<p class="sendone-empty">No subscriber matches “${esc(q)}” — you can paste a full UUID to send to anyone.</p>`;
}

$('#sendone-search').addEventListener('input', () => {
  clearTimeout(sendOneDebounce);
  sendOneDebounce = setTimeout(() => renderSendOneResults($('#sendone-search').value.trim()), 250);
});

$('#sendone-results').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-sendone-uuid]');
  if (!btn || !sendOnePkg) return;
  $('#sendone-overlay').classList.add('hidden');
  try {
    if (await trySendTo(sendOnePkg.id, btn.dataset.sendoneUuid)) {
      toast('Delivery queued', 'ok');
      loadPackages();
    }
  } catch (err) { toast(err.message, 'err'); }
  sendOnePkg = null;
});

$('#btn-sendone-cancel').addEventListener('click', () => {
  sendOnePkg = null;
  $('#sendone-overlay').classList.add('hidden');
});

// -- send to list modal --

let sendListPkg = null;

function fillListSelect(sel, includeAll) {
  const opts = [];
  if (includeAll) opts.push('<option value="0">All subscribers</option>');
  for (const l of allAudiences()) {
    opts.push(`<option value="${l.id}">${esc(l.name)} (${l.members})</option>`);
  }
  sel.innerHTML = opts.join('');
}

function openSendList(pkg) {
  const targets = allAudiences();
  if (!targets.length) {
    return toast('No lists yet — create one on the Subscribers tab first', 'err');
  }
  sendListPkg = pkg;
  $('#sendlist-title').textContent = `Send “${pkg.name}” to which list(s)?`;
  $('#sendlist-checks').innerHTML = targets.map(l => `
    <label><input type="checkbox" data-send-list="${l.id}">
      ${esc(l.name)} <em style="color:var(--muted)">(${l.members})</em></label>`).join('');
  $('#sendlist-overlay').classList.remove('hidden');
}

$('#btn-sendlist-cancel').addEventListener('click', () =>
  $('#sendlist-overlay').classList.add('hidden'));

$('#btn-sendlist-go').addEventListener('click', async () => {
  if (!sendListPkg) return;
  const picked = [...document.querySelectorAll('#sendlist-checks input:checked')]
    .map(cb => Number(cb.dataset.sendList));
  if (!picked.length) return toast('Tick at least one list', 'err');
  const names = allAudiences().filter(l => picked.includes(l.id)).map(l => l.name);
  $('#sendlist-overlay').classList.add('hidden');
  if (!await confirmModal(`Send “${sendListPkg.name}” to “${names.join('” + “')}” now? `
    + `Members of several of these lists receive it once.`)) return;
  try {
    const r = await api(`/packages/${sendListPkg.id}/send`, {
      method: 'POST', body: { list_ids: picked },
    });
    toast(`Queued ${r.queued} deliveries to ${names.join(', ')}`, 'ok');
    loadPackages();
  } catch (err) { toast(err.message, 'err'); }
});

// ---------------- schedules ----------------

async function loadSchedules() {
  state.schedules = (await api('/schedules')).schedules;
  renderUpcoming();
  if (!$('#tab-calendar').classList.contains('hidden')) renderCalendar();
}

function renderUpcoming() {
  const wrap = $('#upcoming');
  const pending = state.schedules
    .filter(s => s.status === 'pending')
    .sort((a, b) => a.send_at.localeCompare(b.send_at));
  wrap.classList.toggle('hidden', pending.length === 0);
  wrap.innerHTML = pending.map(s => `
    <div class="upcoming-item" data-sid="${s.id}">
      <span>📅</span>
      <span><b>${esc(s.name)}</b>${s.list_name ? ' → ' + esc(s.list_name) : ''}</span>
      <span class="when">${esc(fmtLocal(s.send_at))} (${esc(fmtSLT(s.send_at))} SLT)</span>
      <button class="btn btn-ghost btn-mini" data-act="cancel-schedule">Cancel</button>
    </div>`).join('');
}

$('#upcoming').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act=cancel-schedule]');
  if (!btn) return;
  cancelSchedule(Number(btn.closest('.upcoming-item').dataset.sid));
});

async function cancelSchedule(sid) {
  const s = state.schedules.find(x => x.id === sid);
  if (!s) return;
  if (!await confirmModal(`Cancel the programmed send of “${s.name}” (${fmtLocal(s.send_at)})?`)) return;
  try {
    await api(`/schedules/${sid}`, { method: 'DELETE' });
    toast('Programmed send cancelled', 'ok');
    loadSchedules();
  } catch (err) { toast(err.message, 'err'); }
}

// -- delivery log modal --

let logPkgId = null;
let logPkg = null;

async function openLog(pkg) {
  logPkgId = pkg.id;
  logPkg = pkg;
  $('#log-title').textContent = `Deliveries — ${pkg.name}`;
  $('#log-overlay').classList.remove('hidden');
  await renderLog();
}

async function renderLog() {
  if (logPkgId === null) return;
  const data = await api(`/deliveries?package_id=${logPkgId}`);
  const s = data.stats || {};
  $('#log-stats').textContent =
    `${s.sent || 0} delivered · ${s.pending || 0} pending · ${s.skipped || 0} skipped (offline) · ${s.failed || 0} failed` +
    ` — pending means the kiosk hasn't picked it up yet (touch the kiosk → Sync to hurry it).`;
  // Audiences the package went to, each re-sendable with an online-only choice.
  const oldChecks = {}; // preserve checkbox state across refreshes
  document.querySelectorAll('#log-audiences input[data-relist-oo]').forEach(cb => {
    oldChecks[cb.dataset.relistOo] = cb.checked;
  });
  $('#log-audiences').innerHTML = (data.audiences || []).map(a => {
    const key = String(a.list_id);
    const deleted = a.name === null;
    const checked = key in oldChecks ? oldChecks[key] : !!(logPkg && logPkg.only_online);
    return `<div class="audience-row ${deleted ? 'deleted' : ''}">
      <span>📢 <b>${esc(a.name || '(deleted list)')}</b></span>
      <label title="Deliver this resend only to members who are in-world">
        <input type="checkbox" data-relist-oo="${key}" ${checked ? 'checked' : ''}> only online
      </label>
      <button class="btn btn-ghost btn-mini" data-relist="${key}" ${deleted ? 'disabled' : ''}
        ${deleted ? 'title="This list no longer exists"' : ''}>Redeliver</button>
    </div>`;
  }).join('');

  const statusLabel = { queued: 'pending', inflight: 'delivering…', sent: 'delivered',
    skipped: 'skipped (offline)', failed: 'failed' };
  const cls = { queued: 'st-pending', inflight: 'st-pending', sent: 'st-sent',
    skipped: 'st-skip', failed: 'st-failed' };
  $('#log-rows').innerHTML = data.deliveries.map(d => `
    <tr>
      <td>${esc(d.name || d.uuid)}</td>
      <td><span class="${cls[d.status] || ''}">${esc(statusLabel[d.status] || d.status)}</span></td>
      <td class="mono">${esc(fmtLocal(d.queued_at))}</td>
      <td class="mono">${d.sent_at ? esc(fmtLocal(d.sent_at)) : '—'}</td>
      <td><button class="btn btn-ghost btn-mini" data-redeliver="${d.uuid}">Redeliver</button></td>
    </tr>`).join('') ||
    '<tr><td colspan="5">No deliveries yet for this package.</td></tr>';
}

$('#log-rows').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-redeliver]');
  if (!btn || logPkgId === null) return;
  btn.disabled = true;
  try {
    if (await trySendTo(logPkgId, btn.dataset.redeliver)) {
      toast('Redelivery queued', 'ok');
      renderLog();
    } else {
      btn.disabled = false; // declined the shadow-ban override
    }
  } catch (err) {
    toast(err.message, 'err');
    btn.disabled = false;
  }
});

$('#log-audiences').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-relist]');
  if (!btn || logPkgId === null) return;
  const listId = Number(btn.dataset.relist);
  const onlyOnline = btn.closest('.audience-row')
    .querySelector('input[data-relist-oo]').checked;
  const label = listId === 0 ? 'All subscribers'
    : (allAudiences().find(l => l.id === listId) || { name: 'this list' }).name;
  if (!await confirmModal(`Redeliver “${logPkg.name}” to ${label}`
    + `${onlyOnline ? ' (only members currently online)' : ''}?`
    + ` Anyone already queued won't be queued twice.`)) return;
  try {
    const body = { only_online: onlyOnline };
    if (listId !== 0) body.list_ids = [listId];
    const r = await api(`/packages/${logPkgId}/send`, { method: 'POST', body });
    toast(`Queued ${r.queued} deliveries to ${label}`, 'ok');
    renderLog();
    loadPackages();
  } catch (err) { toast(err.message, 'err'); }
});

$('#btn-log-refresh').addEventListener('click', renderLog);
$('#btn-log-close').addEventListener('click', () => {
  logPkgId = null;
  $('#log-overlay').classList.add('hidden');
});

// -- schedule modal --

function openSchedule(pkg) {
  state.scheduling = pkg.id;
  $('#schedule-title').textContent = `Schedule “${pkg.name}” — pick delivery date & time:`;
  // Default: tomorrow, same hour, minutes at :00 (local time).
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  d.setMinutes(0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  $('#schedule-dt').value =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  updateSltHint();
  fillListSelect($('#schedule-list'), true);
  $('#schedule-overlay').classList.remove('hidden');
}

function updateSltHint() {
  const v = $('#schedule-dt').value;
  const el = $('#schedule-slt');
  if (!v || isNaN(new Date(v))) { el.textContent = ''; return; }
  el.textContent = `= ${fmtSLT(new Date(v).toISOString())} SLT (Second Life time)`;
}
$('#schedule-dt').addEventListener('input', updateSltHint);

$('#btn-schedule-save').addEventListener('click', async () => {
  const v = $('#schedule-dt').value;
  if (!v || isNaN(new Date(v))) return toast('Pick a valid date and time', 'err');
  try {
    await api(`/packages/${state.scheduling}/schedule`, {
      method: 'POST', body: {
        send_at: new Date(v).toISOString(),
        list_id: Number($('#schedule-list').value) || 0,
      },
    });
    $('#schedule-overlay').classList.add('hidden');
    toast('Send programmed', 'ok');
    loadSchedules();
  } catch (err) { toast(err.message, 'err'); }
});
$('#btn-schedule-cancel').addEventListener('click', () =>
  $('#schedule-overlay').classList.add('hidden'));

// -- month calendar --

function renderCalendar() {
  if (!state.calMonth) {
    const t = new Date();
    state.calMonth = new Date(t.getFullYear(), t.getMonth(), 1);
  }
  const y = state.calMonth.getFullYear();
  const m = state.calMonth.getMonth();
  $('#cal-title').textContent = state.calMonth.toLocaleString([], { month: 'long', year: 'numeric' });

  const firstOffset = (new Date(y, m, 1).getDay() + 6) % 7; // Monday-start
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const today = new Date();
  const isToday = (d) =>
    today.getFullYear() === y && today.getMonth() === m && today.getDate() === d;

  // Bucket schedules by local calendar day of this month.
  const byDay = {};
  for (const s of state.schedules) {
    if (s.status === 'cancelled') continue;
    const t = new Date(s.send_at);
    if (t.getFullYear() === y && t.getMonth() === m) {
      (byDay[t.getDate()] = byDay[t.getDate()] || []).push(s);
    }
  }

  let html = '';
  for (let i = 0; i < firstOffset; i++) html += '<div class="cal-cell blank"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const chips = (byDay[d] || [])
      .sort((a, b) => a.send_at.localeCompare(b.send_at))
      .map(s => {
        const hm = new Date(s.send_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const cls = s.status === 'pending' ? 'pending' : 'sent';
        const title = s.status === 'pending'
          ? `Programmed: ${fmtLocal(s.send_at)} (${fmtSLT(s.send_at)} SLT) — tap to cancel`
          : `Sent ${fmtLocal(s.fired_at || s.send_at)}`;
        const label = s.list_name ? `${s.name} → ${s.list_name}` : s.name;
        return `<span class="cal-chip ${cls}" data-sid="${s.id}" title="${esc(title)}">${hm} ${esc(label)}</span>`;
      }).join('');
    html += `<div class="cal-cell ${isToday(d) ? 'today' : ''}"><span class="cal-day">${d}</span>${chips}</div>`;
  }
  $('#cal-grid').innerHTML = html;
}

$('#cal-grid').addEventListener('click', (e) => {
  const chip = e.target.closest('.cal-chip.pending');
  if (chip) cancelSchedule(Number(chip.dataset.sid));
});
$('#cal-prev').addEventListener('click', () => {
  state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() - 1, 1);
  renderCalendar();
});
$('#cal-next').addEventListener('click', () => {
  state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + 1, 1);
  renderCalendar();
});
$('#cal-today').addEventListener('click', () => {
  state.calMonth = null;
  renderCalendar();
});

// ---------------- confirm modal ----------------

function confirmModal(text) {
  return new Promise((resolve) => {
    $('#confirm-text').textContent = text;
    $('#confirm-overlay').classList.remove('hidden');
    const done = (v) => {
      $('#confirm-overlay').classList.add('hidden');
      $('#btn-confirm-yes').onclick = $('#btn-confirm-no').onclick = null;
      resolve(v);
    };
    $('#btn-confirm-yes').onclick = () => done(true);
    $('#btn-confirm-no').onclick = () => done(false);
  });
}

// ---------------- tabs / auth wiring ----------------

document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
  for (const name of ['packages', 'subscribers', 'calendar']) {
    $(`#tab-${name}`).classList.toggle('hidden', t.dataset.tab !== name);
  }
  if (t.dataset.tab === 'calendar') renderCalendar();
}));

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    await api('/login', { method: 'POST', body: { password: $('#login-password').value } });
    $('#login-password').value = '';
    showApp();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#btn-logout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST', body: {} }).catch(() => {});
  showLogin();
});

// Boot: try an authenticated call; fall back to login.
(async () => {
  try { await api('/overview'); showApp(); }
  catch { showLogin(); }
})();
