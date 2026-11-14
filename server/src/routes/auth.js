'use strict';

const config = require('../config');
const { sendJson, readBody, parseJson, HttpError } = require('../http-utils');
const auth = require('../auth');
const users = require('../users');

const MINUTE = 60 * 1000;

/** Sign in, sign up, sign out, and changing your own password. */
function register(router) {
  // Body: { username, password }
  router.post('/api/auth/login', async ({ req, res }) => {
    auth.limit('login', req, 10, MINUTE);
    const body = parseJson(await readBody(req, config.maxJsonBytes));
    auth.assertLoginAllowed(body.username);
    const user = users.checkLogin(body.username, body.password);
    if (!user) {
      auth.recordFailedLogin(body.username);
      throw new HttpError(401, 'That username or password is not correct');
    }
    auth.clearFailedLogins(body.username);
    if (user.status === 'pending') {
      throw new HttpError(403, 'This account is waiting for an admin to approve it');
    }
    if (user.status !== 'active') throw new HttpError(403, 'This account has been disabled');
    users.touchLogin(user.id);
    res.setHeader('Set-Cookie', auth.createSessionCookie(req, user.id));
    sendJson(res, 200, { user: users.present(user) });
  });

  // Body: { username, password, accountType: 'customer' | 'staff' }.
  // Every new account waits for an admin to approve it; nobody can sign up as admin.
  router.post('/api/auth/signup', async ({ req, res }) => {
    auth.limit('signup', req, 5, 60 * MINUTE);
    const body = parseJson(await readBody(req, config.maxJsonBytes));
    const role = body.accountType === 'customer' ? 'customer' : 'staff';
    const user = users.createUser({
      username: body.username, password: body.password, role, status: 'pending',
    });
    sendJson(res, 201, { user: users.present(user) });
  });

  router.post('/api/auth/logout', ({ req, res }) => {
    res.setHeader('Set-Cookie', auth.clearSessionCookie(req));
    sendJson(res, 200, { ok: true });
  });

  // Also tells the sign in page how long videos are kept, which is not a secret.
  router.get('/api/auth/me', ({ req, res }) => {
    const user = auth.currentUser(req);
    sendJson(res, 200, {
      signedIn: Boolean(user),
      user: user ? users.present(user) : null,
      retentionDays: config.retentionDays,
    });
  });

  // Body: { current, next }
  router.post('/api/auth/password', auth.requireUser, async ({ req, res, user }) => {
    auth.limit('password', req, 10, MINUTE);
    const body = parseJson(await readBody(req, config.maxJsonBytes));
    if (!users.verifyPassword(body.current ?? '', user.password_hash)) {
      throw new HttpError(400, 'Your current password is not correct');
    }
    users.setPassword(user.id, body.next);
    sendJson(res, 200, { ok: true });
  });
}

module.exports = { register };
