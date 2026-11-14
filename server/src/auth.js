'use strict';

const crypto = require('node:crypto');
const config = require('./config');
const { one, all, run } = require('./db');
const { HttpError } = require('./http-utils');
const users = require('./users');

const COOKIE = 'hp_session';

function hmacHex(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

/** Constant time comparison that tolerates different lengths. */
function safeEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

function clientAddress(req) {
  if (config.trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || 'unknown';
}

function isHttps(req) {
  return Boolean(req.socket.encrypted)
    || (config.trustProxy && req.headers['x-forwarded-proto'] === 'https');
}

// ---- Dashboard users: signed, expiring cookie that names the user ---------------

function cookieAttributes(req, maxAge) {
  return `HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}

function createSessionCookie(req, userId) {
  const expires = Date.now() + config.sessionHours * 3600 * 1000;
  const payload = `${userId}.${expires}`;
  const value = `${payload}.${hmacHex(config.sessionSecret, payload)}`;
  return `${COOKIE}=${value}; ${cookieAttributes(req, config.sessionHours * 3600)}`;
}

function clearSessionCookie(req) {
  return `${COOKIE}=; ${cookieAttributes(req, 0)}`;
}

/** The signed in, still active user for this request, or null. */
function currentUser(req) {
  const match = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || '');
  if (!match) return null;
  const [userId, expires, signature] = match[1].split('.');
  if (!userId || !expires || !signature || Number(expires) < Date.now()) return null;
  if (!safeEqual(signature, hmacHex(config.sessionSecret, `${userId}.${expires}`))) return null;
  // Looked up on every request, so disabling an account takes effect at once.
  const user = users.findById(Number(userId));
  return user && user.status === 'active' ? user : null;
}

function requireUser(ctx) {
  ctx.user = currentUser(ctx.req);
  if (!ctx.user) throw new HttpError(401, 'Sign in required');
}

function requireAdmin(ctx) {
  requireUser(ctx);
  if (ctx.user.role !== 'admin') throw new HttpError(403, 'Only an admin can do this');
}

/** Delivery company accounts: staff and admins. Customers never pass. */
function requireStaff(ctx) {
  requireUser(ctx);
  if (ctx.user.role !== 'admin' && ctx.user.role !== 'staff') {
    throw new HttpError(403, 'This is only for delivery company staff');
  }
}

function requireCustomer(ctx) {
  requireUser(ctx);
  if (ctx.user.role !== 'customer') throw new HttpError(403, 'This is only for customer accounts');
}

// ---- Rate limiting -----------------------------------------------------------------

const buckets = new Map();

/** Counts one event against `key` and returns how many fall inside the window. */
function count(key, windowMs) {
  const now = Date.now();
  if (buckets.size > 5000) {
    for (const [name, entry] of buckets) if (entry.resetAt < now) buckets.delete(name);
  }
  const entry = buckets.get(key);
  if (!entry || entry.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return 1;
  }
  entry.count += 1;
  return entry.count;
}

/** Allows `max` calls per `windowMs` for each client address, per named bucket. */
function limit(bucket, req, max, windowMs) {
  if (count(`${bucket}:${clientAddress(req)}`, windowMs) > max) {
    throw new HttpError(429, 'Too many attempts. Wait a little and try again.');
  }
}

// Password guessing is also limited per account, whatever address it comes
// from: ten wrong passwords lock that username for fifteen minutes.
const FAILED_LOGIN_MAX = 10;
const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const failedLoginKey = (username) => `failed-login:${users.cleanUsername(username).toLowerCase()}`;

function assertLoginAllowed(username) {
  const entry = buckets.get(failedLoginKey(username));
  if (entry && entry.resetAt > Date.now() && entry.count >= FAILED_LOGIN_MAX) {
    throw new HttpError(429, 'Too many wrong passwords for this account. Wait 15 minutes and try again.');
  }
}

function recordFailedLogin(username) {
  count(failedLoginKey(username), FAILED_LOGIN_WINDOW_MS);
}

function clearFailedLogins(username) {
  buckets.delete(failedLoginKey(username));
}

// ---- Driver app: bearer token ------------------------------------------------------

function requireDriver(ctx) {
  const header = ctx.req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (token) {
    for (const driver of all('SELECT id, token FROM drivers WHERE disabled = 0')) {
      if (safeEqual(token, driver.token)) {
        ctx.driverId = driver.id;
        run('UPDATE drivers SET last_seen_at = ? WHERE id = ?', Date.now(), driver.id);
        return;
      }
    }
  }
  throw new HttpError(401, 'Unknown driver token');
}

// ---- Helmet: HMAC SHA256 of the raw request body --------------------------------------

/** Returns the device id when the signature matches, otherwise throws 401. */
function verifyDevice(req, rawBody) {
  const deviceId = String(req.headers['x-device-id'] || '');
  const signature = String(req.headers['x-signature'] || '').toLowerCase();
  const device = one('SELECT id, secret FROM devices WHERE id = ? AND disabled = 0', deviceId);
  if (!device || !signature) throw new HttpError(401, 'Unknown device');
  const expected = crypto.createHmac('sha256', device.secret).update(rawBody).digest('hex');
  if (!safeEqual(signature, expected)) throw new HttpError(401, 'Bad signature');
  run('UPDATE devices SET last_seen_at = ? WHERE id = ?', Date.now(), device.id);
  return device.id;
}

module.exports = {
  createSessionCookie, clearSessionCookie, currentUser, requireUser, requireAdmin, requireStaff, requireCustomer,
  limit, assertLoginAllowed, recordFailedLogin, clearFailedLogins,
  isHttps, requireDriver, verifyDevice,
};
