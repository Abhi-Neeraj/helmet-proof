'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const config = require('./config');
const { Router, HttpError, sendJson } = require('./http-utils');
const recordings = require('./recordings');
const users = require('./users');
const locations = require('./locations');
const { lanUrls } = require('./public-url');
const { isHttps } = require('./auth');

const router = new Router();
router.get('/api/health', ({ res }) => sendJson(res, 200, { ok: true, time: Date.now() }));
require('./routes/auth').register(router);
require('./routes/device').register(router);
require('./routes/driver').register(router);
require('./routes/staff').register(router);
require('./routes/admin').register(router);
require('./routes/tracking').register(router);
require('./routes/customer').register(router);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' https://unpkg.com",
    "style-src 'self' https://fonts.googleapis.com https://unpkg.com",
    "font-src 'self' https://fonts.gstatic.com https://unpkg.com",
    // Map tiles from OpenStreetMap.
    "img-src 'self' data: blob: https://tile.openstreetmap.org",
    "connect-src 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

function sendFile(res, file, status = 200) {
  const body = fs.readFileSync(file);
  res.writeHead(status, {
    'Content-Type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

/** Short public addresses for the driver page and the customer tracking links. */
const PAGE_ALIASES = [
  [/^\/driver\/?$/, 'driver.html'],
  [/^\/track\/[A-Za-z0-9_-]{10,64}\/?$/, 'track.html'],
];

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
  const alias = PAGE_ALIASES.find(([pattern]) => pattern.test(url.pathname));
  const relative = alias ? alias[1]
    : url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = path.resolve(config.publicDir, relative);
  const inside = file.startsWith(config.publicDir + path.sep);
  if (inside && fs.existsSync(file) && fs.statSync(file).isFile()) {
    sendFile(res, file);
    return;
  }
  sendFile(res, path.join(config.publicDir, '404.html'), 404);
}

const server = http.createServer(async (req, res) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  // Once a browser has reached the site over https, tell it never to fall back to http.
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      await router.handle(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error(error);
    sendJson(res, status, { error: status === 500 ? 'Something went wrong on the server' : error.message });
  }
});

function runRetention() {
  try {
    const removed = recordings.expireOldRecordings();
    if (removed) console.log(`Retention: deleted ${removed} video(s) older than ${config.retentionDays} days`);
    locations.expireBefore(Date.now() - config.retentionDays * 24 * 3600 * 1000);
  } catch (error) {
    console.error('Retention failed', error);
  }
}

/** Makes sure somebody can sign in on a fresh install. */
function ensureAdmin() {
  if (users.activeAdminCount() > 0) return;
  const { username, password } = config.bootstrapAdmin;
  if (username && password) {
    users.createUser({ username, password, role: 'admin', status: 'active' });
    console.log(`Created the first admin account "${users.cleanUsername(username)}" from ADMIN_USERNAME.`);
    return;
  }
  console.warn('No admin account exists yet. Create one with:');
  console.warn('  npm run create-user -- --username "Your Name" --password "your password" --role admin');
}

// Helmets send live frames every few seconds over one connection. Keep idle
// connections open longer than that, so each frame does not pay for a new one.
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 66 * 1000;

server.listen(config.port, () => {
  console.log(`Helmet Proof is running at http://localhost:${config.port}`);
  for (const address of lanUrls()) console.log(`  on your network: ${address}`);
  ensureAdmin();
  runRetention();
  setInterval(runRetention, 3600 * 1000).unref();
});
