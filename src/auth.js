'use strict';
/*
 * Operator UI auth — deliberately simple (internal tool, one operator):
 * - Password check against OPERATOR_PASSWORD_HASH, format
 *   "scrypt$<salt base64>$<hash base64>" (generate: npm run hash-password).
 * - Session cookie: signed (HMAC-SHA256, SESSION_SECRET), expiring payload.
 */
const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  try {
    if (!stored || typeof stored !== 'string') return false;
    const [scheme, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (_) {
    return false;
  }
}

function signSession(secret, ttlMs = 12 * 60 * 60 * 1000, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ exp: now + ttlMs, op: true })).toString('base64url');
  const sig = crypto.createHmac('sha256', String(secret || '')).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifySession(value, secret, now = Date.now()) {
  try {
    if (!value) return false;
    const [body, sig] = String(value).split('.');
    if (!body || !sig) return false;
    const expected = crypto.createHmac('sha256', String(secret || '')).update(body).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.op === true && typeof payload.exp === 'number' && payload.exp > now;
  } catch (_) {
    return false;
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

module.exports = { hashPassword, verifyPassword, signSession, verifySession, parseCookies };
