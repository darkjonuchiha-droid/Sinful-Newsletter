'use strict';
/* Sinful Newsletter Hub — admin SPA (vanilla, no build step) */

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  packages: [],
  subscribers: [],
  kiosk: { online: false, inventory: [] },
  overview: null,
  editing: null,      // null | {id?} package being edited
  editItems: new Set,
  pollTimer: null,
};

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
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
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
  await Promise.all([loadOverview(), loadPackages(), loadSubscribers(), loadKiosk()]);
}

async function pollTick() {
  try {
    await loadOverview();
    // While a blast is running, keep package stats live.
    if (state.overview && state.overview.sending.length) await loadPackages();
  } catch { /* transient */ }
}

// ---------------- overview / kiosk pill ----------------

async function loadOverview() {
  state.overview = await api('/overview');
  const { kioskOnline, kioskLastSeen, pendingLookups, subscribers } = state.overview;
  const pill = $('#kiosk-pill');
  pill.classList.toggle('pill-on', kioskOnline);
  pill.classList.toggle('pill-off', !kioskOnline);
  $('#kiosk-pill-text').textContent = kioskOnline ? 'kiosk online' : 'kiosk offline';
  pill.title = kioskLastSeen ? `Last seen (UTC): ${kioskLastSeen}` : 'Kiosk has never connected';
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
    const total = pending + sent + failed;
    const chips = p.items.map(name =>
      `<span class="item-chip ${invNames.has(name) ? '' : 'missing'}"
             title="${invNames.has(name) ? '' : 'No longer in the kiosk inventory!'}">${esc(name)}</span>`
    ).join('') || '<span class="item-chip">message only</span>';
    const progress = pending > 0 && total > 0
      ? `<div class="progress"><div style="width:${Math.round(100 * sent / total)}%"></div></div>` : '';
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
            <span class="stat-pending">pending <b>${pending}</b></span>
            <span class="stat-failed">failed <b>${failed}</b></span>
          </div>
          <div class="pkg-actions">
            <button class="btn btn-primary btn-mini" data-act="send">Send to all</button>
            <button class="btn btn-ghost btn-mini" data-act="test">Send to one…</button>
            <button class="btn btn-ghost btn-mini" data-act="edit">Edit</button>
            <button class="btn btn-ghost btn-mini" data-act="delete">Delete</button>
          </div>
        </div>
      </article>`;
  }).join('');
}

$('#package-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.closest('.pkg-card').dataset.id);
  const pkg = state.packages.find(p => p.id === id);
  if (!pkg) return;
  const act = btn.dataset.act;

  if (act === 'edit') return openEditor(pkg);

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

  if (act === 'test') {
    const input = prompt('Send to (UUID, or the exact name of an existing subscriber):');
    if (!input) return;
    try {
      await api(`/packages/${id}/sendto`, { method: 'POST', body: { input } });
      toast('Delivery queued', 'ok');
      loadPackages();
    } catch (err) { toast(err.message, 'err'); }
  }
});

// ---------------- package editor ----------------

function openEditor(pkg) {
  state.editing = pkg ? { id: pkg.id } : {};
  state.editItems = new Set(pkg ? pkg.items : []);
  $('#editor-title').textContent = pkg ? 'Edit package' : 'New package';
  $('#pkg-name').value = pkg ? pkg.name : '';
  $('#pkg-message').value = pkg ? pkg.message : '';
  updateMsgCount();
  renderItemGrid();
  $('#editor-overlay').classList.remove('hidden');
  $('#pkg-name').focus();
}

function renderItemGrid() {
  const grid = $('#pkg-items');
  const inv = state.kiosk.inventory;
  const warn = $('#pkg-kiosk-warn');
  if (!state.kiosk.online) {
    warn.textContent = 'Kiosk is offline — this item list is from its last report and may be stale.';
    warn.classList.remove('hidden');
  } else warn.classList.add('hidden');

  if (!inv.length) {
    grid.innerHTML = '<p class="hint">No items reported yet. Drop notecards, landmarks or objects ' +
      'into the kiosk prim in-world — they appear here automatically.</p>';
    return;
  }
  // Items selected earlier but no longer in inventory are shown so they can be unticked.
  const gone = [...state.editItems].filter(n => !inv.some(i => i.name === n));
  grid.innerHTML = inv.map(i => itemCheckHtml(i.name, i.type, i.ok, state.editItems.has(i.name), false))
    .concat(gone.map(n => itemCheckHtml(n, 'missing', 0, true, true)))
    .join('');
}

function itemCheckHtml(name, type, ok, checked, missing) {
  const disabled = !ok && !checked;
  const title = missing ? 'No longer in the kiosk — untick or put it back'
    : (!ok ? 'Not copy+transfer — cannot be sent (it would be given away permanently)' : '');
  return `<label class="item-check ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}" title="${esc(title)}">
    <input type="checkbox" data-name="${esc(name)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
    <span>${esc(name)}</span><span class="item-type">${esc(type)}</span>
  </label>`;
}

$('#pkg-items').addEventListener('change', (e) => {
  const cb = e.target.closest('input[type=checkbox]');
  if (!cb) return;
  if (cb.checked) state.editItems.add(cb.dataset.name);
  else state.editItems.delete(cb.dataset.name);
  cb.closest('.item-check').classList.toggle('checked', cb.checked);
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
  const data = await api('/subscribers' + (q ? `?q=${encodeURIComponent(q)}` : ''));
  state.subscribers = data.subscribers;
  renderSubscribers();
}

function renderSubscribers() {
  $('#sub-rows').innerHTML = state.subscribers.map(s => `
    <tr class="${s.active ? '' : 'inactive-row'}" data-uuid="${s.uuid}">
      <td>${esc(s.name)}</td>
      <td class="mono" title="${s.uuid}">${s.uuid}</td>
      <td><span class="src-tag">${esc(s.source)}</span></td>
      <td>
        <label class="toggle" title="${s.active ? 'Active — receives sends' : 'Inactive — skipped on sends'}">
          <input type="checkbox" data-act="toggle" ${s.active ? 'checked' : ''}><i></i>
        </label>
      </td>
      <td><button class="btn btn-ghost btn-mini" data-act="remove">Remove</button></td>
    </tr>`).join('');
}

$('#sub-rows').addEventListener('click', async (e) => {
  const row = e.target.closest('tr[data-uuid]');
  if (!row) return;
  const uuid = row.dataset.uuid;
  const sub = state.subscribers.find(s => s.uuid === uuid);

  if (e.target.closest('button[data-act=remove]')) {
    if (!await confirmModal(`Remove ${sub ? sub.name : uuid} permanently? (Use the Active toggle to pause instead.)`)) return;
    await api(`/subscribers/${uuid}`, { method: 'DELETE' });
    toast('Subscriber removed', 'ok');
    loadSubscribers();
    loadOverview();
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

$('#btn-sub-add').addEventListener('click', addSubscriber);
$('#sub-add-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addSubscriber(); });
async function addSubscriber() {
  const input = $('#sub-add-input').value.trim();
  if (!input) return;
  try {
    const r = await api('/subscribers', { method: 'POST', body: { input } });
    toast(r.note || 'Added', 'ok');
    $('#sub-add-input').value = '';
    loadSubscribers();
    loadOverview();
  } catch (err) { toast(err.message, 'err'); }
}

let searchDebounce;
$('#sub-search').addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(loadSubscribers, 250);
});

// ---------------- kiosk ----------------

async function loadKiosk() {
  state.kiosk = await api('/kiosk-status');
}

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
  $('#tab-packages').classList.toggle('hidden', t.dataset.tab !== 'packages');
  $('#tab-subscribers').classList.toggle('hidden', t.dataset.tab !== 'subscribers');
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
