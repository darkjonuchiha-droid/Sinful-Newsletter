'use strict';
// Public (unauthenticated) routes: one-click unsubscribe pages reached from
// the signed links appended to delivery IMs. No session, no kiosk token —
// the per-avatar HMAC in the URL is the authorization.
const express = require('express');
const db = require('./storage');
const { verifyUnsubToken } = require('./auth');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

function page(res, status, title, body) {
  res.status(status).type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Sinful Newsletter</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center;
    font-family: Georgia, serif; color:#f4e9ee;
    background: linear-gradient(160deg,#1e0d16 0%,#150910 100%); }
  .card { max-width: 420px; text-align:center; padding: 2.5rem 2rem;
    background:#251019; border:1px solid #3d1e2c; border-radius:14px; }
  h1 { font-style: italic; color:#ff3d6e; margin:0 0 1rem; font-size:1.6rem; }
  p { line-height:1.55; color:#c9aab8; margin:.5rem 0; }
  a { color:#d9a441; }
</style></head><body>
<div class="card"><h1>${title}</h1>${body}</div>
</body></html>`);
}

function validRequest(req) {
  const uuid = String(req.params.uuid || '').toLowerCase();
  if (!UUID_RE.test(uuid)) return null;
  if (!verifyUnsubToken(uuid, req.params.token)) return null;
  return uuid;
}

router.get('/u/:uuid/:token', wrap(async (req, res) => {
  const uuid = validRequest(req);
  if (!uuid) return page(res, 404, 'Link not valid', '<p>This unsubscribe link is not valid.</p>');
  const r = await db.run('UPDATE subscribers SET active = 0 WHERE uuid = ?', [uuid]);
  if (!r.changes) {
    return page(res, 404, 'Not subscribed',
      '<p>This avatar is not on the subscriber list (perhaps already removed).</p>');
  }
  page(res, 200, 'Unsubscribed',
    `<p>You won't receive any more newsletters or packages.</p>
     <p>Changed your mind? <a href="/u/${uuid}/${req.params.token}/resub">Resubscribe</a></p>
     <p>You can also subscribe again anytime at the in-world kiosk.</p>`);
}));

router.get('/u/:uuid/:token/resub', wrap(async (req, res) => {
  const uuid = validRequest(req);
  if (!uuid) return page(res, 404, 'Link not valid', '<p>This link is not valid.</p>');
  const r = await db.run('UPDATE subscribers SET active = 1 WHERE uuid = ?', [uuid]);
  if (!r.changes) {
    return page(res, 404, 'Not found', '<p>This avatar is not on the subscriber list.</p>');
  }
  page(res, 200, 'Welcome back!',
    '<p>You are subscribed again and will receive future newsletters.</p>');
}));

module.exports = { router };
