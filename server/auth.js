'use strict';
// Password hashing with Node's built-in scrypt (no native deps), and
// opaque session tokens stored in the sessions table.
const crypto = require('crypto');
const { q, one } = require('./db');

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(String(password), salt, 64, (err, key) => {
      if (err) return reject(err);
      resolve(`scrypt:${salt}:${key.toString('hex')}`);
    });
  });
}

function verifyPassword(password, stored) {
  return new Promise((resolve) => {
    if (!stored || !stored.startsWith('scrypt:')) return resolve(false);
    const [, salt, hex] = stored.split(':');
    crypto.scrypt(String(password), salt, 64, (err, key) => {
      if (err) return resolve(false);
      const expected = Buffer.from(hex, 'hex');
      resolve(expected.length === key.length && crypto.timingSafeEqual(expected, key));
    });
  });
}

const SESSION_DAYS = 30;

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  await q('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)', [token, userId, expires]);
  return token;
}

async function userForToken(token) {
  if (!token) return null;
  const row = await one(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = $1 AND s.expires_at > now() AND u.active = TRUE`,
    [token]
  );
  return row;
}

async function destroySession(token) {
  if (token) await q('DELETE FROM sessions WHERE token = $1', [token]);
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token) {
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}` +
    (process.env.NODE_ENV === 'production' ? '; Secure' : '');
}

// Express middleware: attaches req.user / req.companyId. Does not reject —
// pair with requireAuth on protected routes.
async function loadSession(req, res, next) {
  try {
    const cookies = parseCookies(req);
    req.sessionToken = cookies.sid || null;
    req.user = req.sessionToken ? await userForToken(req.sessionToken) : null;
    req.companyId = req.user && req.user.role !== 'platform' ? req.user.company_id : null;
    next();
  } catch (e) {
    next(e);
  }
}

function requireAuth(req, res, next) {
  if (!req.user) return res.redirect('/login');
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (req.user.role === 'platform') return next();
    if (!roles.includes(req.user.role)) return res.status(403).send('Your role does not include access to this page.');
    next();
  };
}

module.exports = { hashPassword, verifyPassword, createSession, userForToken, destroySession, parseCookies, sessionCookie, loadSession, requireAuth, requireRole };
