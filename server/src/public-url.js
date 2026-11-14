'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('./config');

// start-live.bat writes the Cloudflare tunnel's output here, including the
// random public address it was given.
const TUNNEL_LOG = path.resolve(process.env.TUNNEL_LOG || path.join(__dirname, '..', '..', 'tunnel', 'tunnel.log'));
const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/g;

let cached = { mtimeMs: -1, url: null };

/**
 * The address people outside this network can use, or null when there is none.
 * PUBLIC_URL wins when set (a cloud host or a fixed domain); otherwise the
 * newest address in the tunnel log.
 */
function publicUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  try {
    const { mtimeMs } = fs.statSync(TUNNEL_LOG);
    if (mtimeMs !== cached.mtimeMs) {
      const matches = fs.readFileSync(TUNNEL_LOG, 'utf8').match(TUNNEL_URL);
      cached = { mtimeMs, url: matches ? matches[matches.length - 1] : null };
    }
    return cached.url;
  } catch {
    return null;
  }
}

/** Addresses on the local network, for a helmet on the same Wi-Fi as this computer. */
function lanUrls() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((address) => address && address.family === 'IPv4' && !address.internal)
    .map((address) => `http://${address.address}:${config.port}`);
}

module.exports = { publicUrl, lanUrls };
