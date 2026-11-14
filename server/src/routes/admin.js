'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const { one, all, run } = require('../db');
const { sendJson, readBody, parseJson, HttpError } = require('../http-utils');
const { requireAdmin } = require('../auth');
const users = require('../users');
const recordings = require('../recordings');
const live = require('../live');

const ID = /^[A-Za-z0-9_-]{1,32}$/;
const ROLES = ['admin', 'staff', 'customer'];

function text(value, field, max) {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field} is required`);
  return value.trim().slice(0, max);
}

const newDriverToken = () => crypto.randomBytes(24).toString('base64url');
const newDeviceSecret = () => crypto.randomBytes(24).toString('hex');

/** "DRV-001", "DRV-002", ... the first number not in use. */
function nextDriverId() {
  for (let n = 1; n < 100000; n += 1) {
    const id = `DRV-${String(n).padStart(3, '0')}`;
    if (!one('SELECT 1 AS x FROM drivers WHERE id = ?', id)) return id;
  }
  throw new HttpError(500, 'Could not allocate a driver id');
}

function presentDriver(row) {
  return {
    id: row.id,
    name: row.name,
    token: row.token,
    disabled: Boolean(row.disabled),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    openDeliveries: row.open_deliveries,
  };
}

function presentDevice(row) {
  return {
    id: row.id,
    label: row.label,
    secret: row.secret,
    disabled: Boolean(row.disabled),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    videos: row.videos,
    live: live.summary(live.forDevice(row.id)),
  };
}

const DRIVER_SELECT = `
  SELECT d.*, (SELECT COUNT(*) FROM deliveries x WHERE x.driver_id = d.id
               AND x.status IN ('assigned', 'in_progress')) AS open_deliveries
  FROM drivers d`;

const DEVICE_SELECT = `
  SELECT d.*, (SELECT COUNT(*) FROM recordings r WHERE r.device_id = d.id) AS videos
  FROM devices d`;

/** Everything only an admin may do: the video library, people, drivers, helmets. */
function register(router) {
  const admin = requireAdmin;
  const body = async (req) => parseJson(await readBody(req, config.maxJsonBytes));

  // ---- Video library -----------------------------------------------------------

  router.get('/api/admin/recordings', admin, ({ res, url }) => {
    sendJson(res, 200, {
      recordings: recordings.listAllRecordings({
        q: (url.searchParams.get('q') || '').trim(),
        status: url.searchParams.get('status') || '',
      }),
      totals: recordings.storageTotals(),
      retentionDays: config.retentionDays,
    });
  });

  // ---- People --------------------------------------------------------------------

  router.get('/api/admin/users', admin, ({ res }) => {
    sendJson(res, 200, { users: users.listUsers() });
  });

  // Body: { username, password, role }. Active at once; no approval step.
  router.post('/api/admin/users', admin, async (ctx) => {
    const input = await body(ctx.req);
    if (!ROLES.includes(input.role)) throw new HttpError(400, 'Choose customer, staff or admin');
    const user = users.createUser({
      username: input.username, password: input.password, role: input.role, status: 'active',
    });
    sendJson(ctx.res, 201, { user: users.present(user) });
  });

  function targetUser(ctx) {
    const target = users.findById(Number(ctx.params.id));
    if (!target) throw new HttpError(404, 'Account not found');
    return target;
  }

  // Body: { status?, role? }. Approving a signup is status "active".
  router.post('/api/admin/users/:id', admin, async (ctx) => {
    const target = targetUser(ctx);
    const change = await body(ctx.req);
    const status = change.status ?? target.status;
    const role = change.role ?? target.role;
    if (!['active', 'disabled'].includes(status) && status !== target.status) {
      throw new HttpError(400, 'Status must be active or disabled');
    }
    if (!ROLES.includes(role)) throw new HttpError(400, 'Role must be admin, staff or customer');
    if (target.id === ctx.user.id && (status !== 'active' || role !== 'admin')) {
      throw new HttpError(400, 'You cannot disable or demote your own account');
    }
    run('UPDATE users SET status = ?, role = ? WHERE id = ?', status, role, target.id);
    if (users.activeAdminCount() === 0) {
      run('UPDATE users SET status = ?, role = ? WHERE id = ?', target.status, target.role, target.id);
      throw new HttpError(400, 'At least one active admin is needed');
    }
    sendJson(ctx.res, 200, { user: users.present(users.findById(target.id)) });
  });

  // Body: { password }
  router.post('/api/admin/users/:id/password', admin, async (ctx) => {
    const target = targetUser(ctx);
    users.setPassword(target.id, (await body(ctx.req)).password);
    sendJson(ctx.res, 200, { ok: true });
  });

  router.post('/api/admin/users/:id/remove', admin, (ctx) => {
    const target = targetUser(ctx);
    if (target.id === ctx.user.id) throw new HttpError(400, 'You cannot remove your own account');
    run('DELETE FROM users WHERE id = ?', target.id);
    sendJson(ctx.res, 200, { ok: true });
  });

  // ---- Drivers -------------------------------------------------------------------

  router.get('/api/admin/drivers', admin, ({ res }) => {
    sendJson(res, 200, { drivers: all(`${DRIVER_SELECT} ORDER BY d.created_at`).map(presentDriver) });
  });

  // Body: { name, id? }
  router.post('/api/admin/drivers', admin, async ({ req, res }) => {
    const input = await body(req);
    const id = input.id ? String(input.id).trim() : nextDriverId();
    if (!ID.test(id)) throw new HttpError(400, 'Driver ID can use letters, numbers, dashes and underscores');
    if (one('SELECT 1 AS x FROM drivers WHERE id = ?', id)) throw new HttpError(409, `Driver ${id} already exists`);
    run('INSERT INTO drivers (id, name, token, created_at) VALUES (?, ?, ?, ?)',
      id, text(input.name, 'Name', 80), newDriverToken(), Date.now());
    sendJson(res, 201, { driver: presentDriver(one(`${DRIVER_SELECT} WHERE d.id = ?`, id)) });
  });

  function targetDriver(ctx) {
    const driver = one('SELECT * FROM drivers WHERE id = ?', ctx.params.id);
    if (!driver) throw new HttpError(404, 'Driver not found');
    return driver;
  }

  // Body: { disabled }
  router.post('/api/admin/drivers/:id', admin, async (ctx) => {
    const driver = targetDriver(ctx);
    run('UPDATE drivers SET disabled = ? WHERE id = ?', (await body(ctx.req)).disabled ? 1 : 0, driver.id);
    sendJson(ctx.res, 200, { ok: true });
  });

  // A new token signs the old phone out.
  router.post('/api/admin/drivers/:id/token', admin, (ctx) => {
    const driver = targetDriver(ctx);
    run('UPDATE drivers SET token = ? WHERE id = ?', newDriverToken(), driver.id);
    sendJson(ctx.res, 200, { driver: presentDriver(one(`${DRIVER_SELECT} WHERE d.id = ?`, driver.id)) });
  });

  // ---- Helmets -------------------------------------------------------------------

  router.get('/api/admin/devices', admin, ({ res }) => {
    sendJson(res, 200, { devices: all(`${DEVICE_SELECT} ORDER BY d.created_at`).map(presentDevice) });
  });

  // Body: { id, label? }
  router.post('/api/admin/devices', admin, async ({ req, res }) => {
    const input = await body(req);
    const id = text(input.id, 'Helmet ID', 32);
    if (!ID.test(id)) throw new HttpError(400, 'Helmet ID can use letters, numbers, dashes and underscores');
    if (one('SELECT 1 AS x FROM devices WHERE id = ?', id)) throw new HttpError(409, `Helmet ${id} already exists`);
    run('INSERT INTO devices (id, label, secret, created_at) VALUES (?, ?, ?, ?)',
      id, typeof input.label === 'string' ? input.label.trim().slice(0, 80) : '', newDeviceSecret(), Date.now());
    sendJson(res, 201, { device: presentDevice(one(`${DEVICE_SELECT} WHERE d.id = ?`, id)) });
  });

  function targetDevice(ctx) {
    const device = one('SELECT * FROM devices WHERE id = ?', ctx.params.id);
    if (!device) throw new HttpError(404, 'Helmet not found');
    return device;
  }

  // Body: { disabled }
  router.post('/api/admin/devices/:id', admin, async (ctx) => {
    const device = targetDevice(ctx);
    run('UPDATE devices SET disabled = ? WHERE id = ?', (await body(ctx.req)).disabled ? 1 : 0, device.id);
    sendJson(ctx.res, 200, { ok: true });
  });

  // A new secret must be flashed into the helmet before it can upload again.
  router.post('/api/admin/devices/:id/secret', admin, (ctx) => {
    const device = targetDevice(ctx);
    run('UPDATE devices SET secret = ? WHERE id = ?', newDeviceSecret(), device.id);
    sendJson(ctx.res, 200, { device: presentDevice(one(`${DEVICE_SELECT} WHERE d.id = ?`, device.id)) });
  });
}

module.exports = { register };
