'use strict';

const config = require('../config');
const { one, all, run, logEvent, newTrackToken } = require('../db');
const { sendJson, readBody, parseJson, HttpError } = require('../http-utils');
const auth = require('../auth');
const { publicUrl, lanUrls } = require('../public-url');
const { DELIVERY_ID, TAMPER_FLAGS, describeFlags } = require('../chunk-format');
const recordings = require('../recordings');

const DELIVERY_SELECT = `
  SELECT d.*,
    (SELECT COUNT(*) FROM tickets t WHERE t.delivery_id = d.id) AS tickets,
    (SELECT COUNT(*) FROM tickets t WHERE t.delivery_id = d.id AND t.status = 'open') AS open_tickets,
    (SELECT COUNT(*) FROM recordings r WHERE r.delivery_id = d.id) AS recordings,
    (SELECT r.status FROM recordings r WHERE r.delivery_id = d.id ORDER BY r.attempt DESC LIMIT 1) AS video_status
  FROM deliveries d`;

function presentDelivery(row) {
  return {
    id: row.id,
    customerName: row.customer_name,
    address: row.address,
    destLat: row.dest_lat,
    destLon: row.dest_lon,
    driverId: row.driver_id,
    status: row.status,
    attempts: row.attempts,
    proofRecording: row.proof_recording,
    failReason: row.fail_reason,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    tickets: row.tickets,
    openTickets: row.open_tickets,
    recordings: row.recordings,
    videoStatus: row.video_status || 'none',
  };
}

function presentTicket(row) {
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    customerName: row.customer_name,
    raisedBy: row.raised_by,
    reason: row.reason,
    status: row.status,
    resolution: row.resolution,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function text(value, field, max) {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field} is required`);
  return value.trim().slice(0, max);
}

function newDeliveryId() {
  for (let i = 0; i < 20; i += 1) {
    const id = `D${Math.floor(100000 + Math.random() * 900000)}`;
    if (!one('SELECT 1 AS x FROM deliveries WHERE id = ?', id)) return id;
  }
  throw new HttpError(500, 'Could not allocate a delivery id');
}

/** Everything that needs a human to look at it, newest first. */
function computeAlerts() {
  const alerts = [];
  const now = Date.now();

  const missing = all(
    `SELECT d.id, d.delivered_at FROM deliveries d
     WHERE d.status = 'delivered' AND d.delivered_at < ?
       AND NOT EXISTS (SELECT 1 FROM recordings r WHERE r.delivery_id = d.id AND r.status = 'complete')`,
    now - config.missingVideoHours * 3600 * 1000,
  );
  for (const row of missing) {
    alerts.push({
      type: 'missing_video', deliveryId: row.id, at: row.delivered_at,
      message: `Delivered more than ${config.missingVideoHours} hours ago and no complete video has arrived`,
    });
  }

  const incomplete = all(
    `SELECT r.id, r.delivery_id, r.completed_at, r.expected_chunks,
       (SELECT COUNT(*) FROM chunks c WHERE c.recording_id = r.id) AS received
     FROM recordings r
     WHERE r.status IN ('complete', 'interrupted') AND r.expected_chunks IS NOT NULL
       AND (SELECT COUNT(*) FROM chunks c WHERE c.recording_id = r.id) < r.expected_chunks`,
  );
  for (const row of incomplete) {
    alerts.push({
      type: 'missing_chunks', deliveryId: row.delivery_id, recordingId: row.id, at: row.completed_at,
      message: `Video has gaps: ${row.received} of ${row.expected_chunks} parts arrived`,
    });
  }

  const flagged = all(
    'SELECT id, delivery_id, flags, started_at FROM recordings WHERE (flags & ?) != 0 AND status != \'expired\'',
    TAMPER_FLAGS,
  );
  for (const row of flagged) {
    alerts.push({
      type: 'tamper_flag', deliveryId: row.delivery_id, recordingId: row.id, at: row.started_at,
      message: describeFlags(row.flags & TAMPER_FLAGS).join('. '),
    });
  }

  const lost = all(
    'SELECT id, delivery_id, status, COALESCE(completed_at, started_at) AS at FROM recordings WHERE status IN (\'purged\', \'interrupted\')',
  );
  for (const row of lost) {
    alerts.push({
      type: row.status === 'purged' ? 'video_lost' : 'video_interrupted',
      deliveryId: row.delivery_id, recordingId: row.id, at: row.at,
      message: row.status === 'purged'
        ? 'Helmet memory card filled up and this video was deleted before upload'
        : 'Recording was cut short, usually by a power loss',
    });
  }

  const events = all(
    `SELECT delivery_id, recording_id, type, detail, at FROM events
     WHERE type IN ('completed_without_recording', 'completed_far_from_destination', 'camera_disconnected')`,
  );
  for (const row of events) {
    alerts.push({
      type: row.type, deliveryId: row.delivery_id, recordingId: row.recording_id, at: row.at,
      message: row.detail || 'Camera link dropped while recording',
    });
  }

  return alerts.sort((a, b) => b.at - a.at);
}

function deliveryHasTicket(deliveryId) {
  return Boolean(one('SELECT 1 AS x FROM tickets WHERE delivery_id = ? LIMIT 1', deliveryId));
}

/**
 * For staff, a video stays sealed until a ticket exists for its delivery.
 * Admins run the video library and may open any video. Either way the
 * viewing is written to the audit trail with the viewer's username.
 */
function unsealedRecording(recordingId, user) {
  const recording = one('SELECT * FROM recordings WHERE id = ?', recordingId);
  if (!recording) throw new HttpError(404, 'Recording not found');
  if (user.role !== 'admin' && !deliveryHasTicket(recording.delivery_id)) {
    throw new HttpError(403, 'This video is sealed until a ticket is raised for the delivery');
  }
  return recording;
}

/** Checks that an id belongs to a customer account. Returns the id, or null for none. */
function customerAccountId(value) {
  if (value === null || value === undefined || value === '') return null;
  const id = Number(value);
  if (!Number.isInteger(id) || !one('SELECT 1 AS x FROM users WHERE id = ? AND role = \'customer\'', id)) {
    throw new HttpError(400, 'That customer account does not exist');
  }
  return id;
}

/** Endpoints used by delivery company accounts, staff and admin alike. */
function register(router) {
  const staff = auth.requireStaff;

  // ---- Overview --------------------------------------------------------------

  // Customer accounts a delivery can be linked to.
  router.get('/api/customers', staff, ({ res }) => {
    sendJson(res, 200, {
      customers: all('SELECT id, username FROM users WHERE role = \'customer\' AND status = \'active\' ORDER BY username_key'),
    });
  });

  // Body: { customerUserId } (a user id, or null to unlink).
  router.post('/api/deliveries/:id/customer', staff, async ({ req, res, params, user }) => {
    const delivery = one('SELECT id FROM deliveries WHERE id = ?', params.id);
    if (!delivery) throw new HttpError(404, 'Delivery not found');
    const body = parseJson(await readBody(req, config.maxJsonBytes));
    const customerUserId = customerAccountId(body.customerUserId);
    run('UPDATE deliveries SET customer_user_id = ? WHERE id = ?', customerUserId, delivery.id);
    const account = customerUserId ? one('SELECT username FROM users WHERE id = ?', customerUserId) : null;
    logEvent({
      deliveryId: delivery.id, source: 'staff', actor: user.username, type: 'customer_linked',
      detail: account ? `Linked to customer account ${account.username}` : 'Customer account removed',
    });
    sendJson(res, 200, { ok: true });
  });

  // Addresses for building links: the public one (for riders, customers and
  // helmets anywhere) and local network ones (for a helmet on this Wi-Fi).
  router.get('/api/server-info', staff, ({ res }) => {
    sendJson(res, 200, { publicUrl: publicUrl(), lanUrls: lanUrls() });
  });

  // Body: { outcome: 'delivered' | 'failed', reason? }. For when the rider
  // cannot close the delivery themselves. Recorded with the staff member's name.
  router.post('/api/deliveries/:id/close', staff, async ({ req, res, params, user }) => {
    const delivery = one('SELECT * FROM deliveries WHERE id = ?', params.id);
    if (!delivery) throw new HttpError(404, 'Delivery not found');
    if (delivery.status === 'delivered' || delivery.status === 'failed') {
      throw new HttpError(409, 'This delivery is already closed');
    }
    const body = parseJson(await readBody(req, config.maxJsonBytes));
    if (body.outcome !== 'delivered' && body.outcome !== 'failed') {
      throw new HttpError(400, 'Choose delivered or not delivered');
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 300) : '';
    if (body.outcome === 'failed' && !reason) throw new HttpError(400, 'Say why it could not be delivered');
    const now = Date.now();
    if (body.outcome === 'delivered') {
      run('UPDATE deliveries SET status = \'delivered\', delivered_at = ? WHERE id = ?', now, delivery.id);
    } else {
      run('UPDATE deliveries SET status = \'failed\', fail_reason = ?, delivered_at = ? WHERE id = ?', reason, now, delivery.id);
    }
    logEvent({
      deliveryId: delivery.id, source: 'staff', actor: user.username, at: now,
      type: body.outcome === 'delivered' ? 'closed_delivered' : 'closed_failed',
      detail: reason || null,
    });
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/summary', staff, ({ res }) => {
    const count = (sql, ...params) => one(sql, ...params).n;
    sendJson(res, 200, {
      deliveries: count('SELECT COUNT(*) AS n FROM deliveries'),
      delivered: count('SELECT COUNT(*) AS n FROM deliveries WHERE status = \'delivered\''),
      videosStored: count('SELECT COUNT(*) AS n FROM recordings WHERE status = \'complete\''),
      openTickets: count('SELECT COUNT(*) AS n FROM tickets WHERE status = \'open\''),
      alerts: computeAlerts().length,
      storageBytes: count('SELECT COALESCE(SUM(bytes), 0) AS n FROM chunks'),
      retentionDays: config.retentionDays,
    });
  });

  // Drivers a delivery can be assigned to. Tokens are never sent here.
  router.get('/api/drivers', staff, ({ res }) => {
    sendJson(res, 200, { drivers: all('SELECT id, name FROM drivers WHERE disabled = 0 ORDER BY created_at') });
  });

  router.get('/api/alerts', staff, ({ res }) => {
    sendJson(res, 200, { alerts: computeAlerts() });
  });

  // ---- Deliveries ------------------------------------------------------------

  router.get('/api/deliveries', staff, ({ res, url }) => {
    const q = (url.searchParams.get('q') || '').trim();
    const status = url.searchParams.get('status') || '';
    const where = [];
    const params = [];
    if (q) {
      where.push('(d.id LIKE ? OR d.customer_name LIKE ? OR d.address LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    if (status) {
      where.push('d.status = ?');
      params.push(status);
    }
    const sql = `${DELIVERY_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY d.created_at DESC LIMIT 200`;
    sendJson(res, 200, { deliveries: all(sql, ...params).map(presentDelivery) });
  });

  router.post('/api/deliveries', staff, async ({ req, res, user }) => {
    const body = parseJson(await readBody(req, config.maxJsonBytes));
    const id = body.id ? String(body.id).trim() : newDeliveryId();
    if (!DELIVERY_ID.test(id)) {
      throw new HttpError(400, 'Delivery ID can use letters, numbers, dashes and underscores, up to 24 characters');
    }
    if (one('SELECT 1 AS x FROM deliveries WHERE id = ?', id)) {
      throw new HttpError(409, `Delivery ${id} already exists`);
    }
    const lat = Number(body.destLat);
    const lon = Number(body.destLon);
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) throw new HttpError(400, 'Latitude must be between 90 and minus 90');
    if (!Number.isFinite(lon) || Math.abs(lon) > 180) throw new HttpError(400, 'Longitude must be between 180 and minus 180');
    const driverId = text(body.driverId, 'Driver', 40);
    if (!one('SELECT 1 AS x FROM drivers WHERE id = ? AND disabled = 0', driverId)) {
      throw new HttpError(400, 'Unknown driver');
    }
    const customerUserId = customerAccountId(body.customerUserId);

    run(
      `INSERT INTO deliveries
         (id, customer_name, address, dest_lat, dest_lon, driver_id, created_at, track_token, customer_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, text(body.customerName, 'Customer name', 120), text(body.address, 'Address', 300),
      lat, lon, driverId, Date.now(), newTrackToken(), customerUserId,
    );
    logEvent({
      deliveryId: id, source: 'staff', type: 'delivery_created',
      detail: `Assigned to ${driverId}`, actor: user.username,
    });
    sendJson(res, 201, { id });
  });

  router.get('/api/deliveries/:id', staff, ({ res, params, user }) => {
    const row = one(`${DELIVERY_SELECT} WHERE d.id = ?`, params.id);
    if (!row) throw new HttpError(404, 'Delivery not found');
    const tickets = all(
      'SELECT t.*, NULL AS customer_name FROM tickets t WHERE t.delivery_id = ? ORDER BY t.created_at DESC',
      params.id,
    );
    sendJson(res, 200, {
      delivery: presentDelivery(row),
      driver: one('SELECT id, name FROM drivers WHERE id = ?', row.driver_id) || { id: row.driver_id, name: row.driver_id },
      customerAccount: row.customer_user_id
        ? one('SELECT id, username, status FROM users WHERE id = ?', row.customer_user_id) || null
        : null,
      recordings: recordings.recordingsForDelivery(params.id),
      tickets: tickets.map(presentTicket),
      events: all('SELECT source, type, detail, actor, recording_id AS recordingId, at FROM events WHERE delivery_id = ? ORDER BY at, id', params.id),
      hasTicket: tickets.length > 0,
      trackToken: row.track_token,
      videoUnlocked: tickets.length > 0 || user.role === 'admin',
    });
  });

  // ---- Tickets ---------------------------------------------------------------

  router.post('/api/deliveries/:id/tickets', staff, async ({ req, res, params, user }) => {
    if (!one('SELECT 1 AS x FROM deliveries WHERE id = ?', params.id)) throw new HttpError(404, 'Delivery not found');
    const body = parseJson(await readBody(req, config.maxJsonBytes));
    const raisedBy = ['customer', 'driver', 'staff'].includes(body.raisedBy) ? body.raisedBy : null;
    if (!raisedBy) throw new HttpError(400, 'Choose who raised the ticket');
    const reason = text(body.reason, 'Reason', 1000);
    const result = run(
      'INSERT INTO tickets (delivery_id, raised_by, reason, created_at) VALUES (?, ?, ?, ?)',
      params.id, raisedBy, reason, Date.now(),
    );
    logEvent({
      deliveryId: params.id, source: 'staff', type: 'ticket_raised',
      detail: `On behalf of the ${raisedBy}`, actor: user.username,
    });
    sendJson(res, 201, { id: Number(result.lastInsertRowid) });
  });

  router.get('/api/tickets', staff, ({ res, url }) => {
    const status = url.searchParams.get('status');
    const rows = all(
      `SELECT t.*, d.customer_name FROM tickets t LEFT JOIN deliveries d ON d.id = t.delivery_id
       ${status ? 'WHERE t.status = ?' : ''} ORDER BY t.created_at DESC LIMIT 200`,
      ...(status ? [status] : []),
    );
    sendJson(res, 200, { tickets: rows.map(presentTicket) });
  });

  router.post('/api/tickets/:id/resolve', staff, async ({ req, res, params, user }) => {
    const ticket = one('SELECT * FROM tickets WHERE id = ?', Number(params.id));
    if (!ticket) throw new HttpError(404, 'Ticket not found');
    const body = parseJson(await readBody(req, config.maxJsonBytes));
    const resolution = text(body.resolution, 'Resolution', 1000);
    run('UPDATE tickets SET status = \'resolved\', resolution = ?, resolved_at = ? WHERE id = ?',
      resolution, Date.now(), ticket.id);
    logEvent({
      deliveryId: ticket.delivery_id, source: 'staff', type: 'ticket_resolved',
      detail: resolution.slice(0, 300), actor: user.username,
    });
    sendJson(res, 200, { ok: true });
  });

  // ---- Video playback (sealed until a ticket exists) ---------------------------

  router.get('/api/recordings/:id/frames', staff, ({ res, params, user }) => {
    const recording = unsealedRecording(params.id, user);
    const index = recordings.getFrameIndex(recording.id);
    logEvent({
      deliveryId: recording.delivery_id, recordingId: recording.id, source: 'staff',
      type: 'video_opened', actor: user.username,
    });
    sendJson(res, 200, {
      recordingId: recording.id,
      startEpoch: index.startEpoch,
      lat: index.lat,
      lon: index.lon,
      times: index.frames.map((frame) => frame.t),
    });
  });

  router.get('/api/recordings/:id/frames/:n', staff, ({ res, params, user }) => {
    const recording = unsealedRecording(params.id, user);
    const jpeg = recordings.readFrame(recording.id, Number(params.n));
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': jpeg.length,
      'Cache-Control': 'private, max-age=3600',
    });
    res.end(jpeg);
  });
}

module.exports = { register };
