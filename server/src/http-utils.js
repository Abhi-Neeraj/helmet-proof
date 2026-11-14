'use strict';

/** An error that maps directly to an HTTP response. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/** Reads the whole request body, rejecting anything over `limit` bytes. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] || 0) > limit) {
      req.resume();
      reject(new HttpError(413, 'Request body too large'));
      return;
    }
    const parts = [];
    let size = 0;
    req.on('data', (part) => {
      size += part.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      parts.push(part);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

function parseJson(buffer) {
  if (!buffer.length) return {};
  try {
    const value = JSON.parse(buffer.toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('not an object');
    }
    return value;
  } catch {
    throw new HttpError(400, 'Body must be a JSON object');
  }
}

/**
 * Minimal method + path router. Patterns use ":name" for path parameters.
 * Handlers receive a context { req, res, url, params } and may be async.
 * A handler that ends the response stops the chain.
 */
class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, ...handlers) {
    const names = [];
    const source = pattern.replace(/:([A-Za-z]+)/g, (_, name) => {
      names.push(name);
      return '([^/]+)';
    });
    this.routes.push({ method, regex: new RegExp(`^${source}$`), names, handlers });
  }

  get(pattern, ...handlers) { this.add('GET', pattern, ...handlers); }
  post(pattern, ...handlers) { this.add('POST', pattern, ...handlers); }

  async handle(req, res, url) {
    let pathMatched = false;
    for (const route of this.routes) {
      const match = route.regex.exec(url.pathname);
      if (!match) continue;
      pathMatched = true;
      if (route.method !== req.method) continue;
      const params = {};
      route.names.forEach((name, i) => { params[name] = decodeURIComponent(match[i + 1]); });
      const ctx = { req, res, url, params };
      for (const handler of route.handlers) {
        await handler(ctx);
        if (res.writableEnded) return;
      }
      return;
    }
    throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Method not allowed' : 'Not found');
  }
}

module.exports = { HttpError, Router, sendJson, readBody, parseJson };
