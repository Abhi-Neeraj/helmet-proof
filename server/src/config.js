'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(dataDir, { recursive: true });

/**
 * The key that signs login cookies. Taken from SESSION_SECRET when set,
 * otherwise generated once and kept in the data folder so that restarting
 * the server does not sign everybody out.
 */
function loadSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(dataDir, 'session.key');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

module.exports = {
  port: Number(process.env.PORT || 3000),
  dataDir,
  publicDir: path.join(__dirname, '..', 'public'),
  sessionSecret: loadSessionSecret(),
  sessionHours: 12,
  retentionDays: Number(process.env.RETENTION_DAYS || 30),
  missingVideoHours: Number(process.env.MISSING_VIDEO_HOURS || 6),
  maxChunkBytes: 16 * 1024 * 1024,
  maxJsonBytes: 100 * 1024,

  // Set TRUST_PROXY=1 when the server sits behind a reverse proxy or a hosting
  // platform, so client addresses and https are read from the forwarded headers.
  trustProxy: process.env.TRUST_PROXY === '1',

  // Creates the first admin on a fresh install (used on hosting platforms where
  // you cannot run the create-user tool). Ignored once any admin exists.
  bootstrapAdmin: {
    username: process.env.ADMIN_USERNAME || '',
    password: process.env.ADMIN_PASSWORD || '',
  },
};
