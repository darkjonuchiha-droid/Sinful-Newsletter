'use strict';
const crypto = require('node:crypto');
const config = require('./config');

// Cookie-signing secret derived from the configured secrets (stable across restarts).
const secret = crypto.createHash('sha256')
  .update('sinful-hub|' + config.adminPassword + '|' + config.kioskToken)
  .digest();

function sign(value) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function makeSessionCookie() {
  const exp = String(Date.now() + config.sessionHours * 3600 * 1000);
  return exp + '.' + sign(exp);
}

function verifySessionCookie(value) {
  if (!value) return false;
  const dot = value.indexOf('.');
  if (dot === -1) return false;
  const exp = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  const expected = sign(exp);
  if (mac.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  return Number(exp) > Date.now();
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > -1) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // Compare anyway against self to keep timing flat, then fail.
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

// --- middleware ---

function requireAdmin(req, res, next) {
  if (verifySessionCookie(parseCookies(req).sn_auth)) return next();
  res.status(401).json({ error: 'not logged in' });
}

function requireKiosk(req, res, next) {
  if (timingSafeEqualStr(req.get('x-kiosk-token') || '', config.kioskToken)) return next();
  res.status(401).json({ error: 'bad kiosk token' });
}

// Simple per-IP login throttle: 5 failures locks for 60 s.
const failures = new Map();
function loginAllowed(ip) {
  const f = failures.get(ip);
  return !(f && f.count >= 5 && Date.now() - f.last < 60000);
}
function loginFailed(ip) {
  const f = failures.get(ip) || { count: 0, last: 0 };
  if (Date.now() - f.last > 60000) f.count = 0;
  f.count++;
  f.last = Date.now();
  failures.set(ip, f);
}
function loginSucceeded(ip) {
  failures.delete(ip);
}

module.exports = {
  makeSessionCookie, verifySessionCookie, parseCookies,
  timingSafeEqualStr, requireAdmin, requireKiosk,
  loginAllowed, loginFailed, loginSucceeded,
};
