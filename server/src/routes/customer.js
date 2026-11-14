'use strict';

const config = require('../config');
const { one, all, run, logEvent } = require('../db');
const { sendJson, readBody, parseJson, HttpError } = require('../http-utils');
const auth = require('../auth');
const live = require('../live');

const PROBLEMS = {
  not_received: 'Parcel not received',
  damaged: 'Parcel arrived damaged',
  wrong_item: 'Wrong item delivered',
  late: 'Delivery very late',
  other: 'Other problem',
};

/** At most this many unresolved problems per delivery, so one customer cannot flood staff. */
const MAX_OPEN_PER_DELIVERY = 3;

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

/** A customer's view of one delivery. Never includes videos or internal notes. */
function present(row) {
  const driver = one('SELECT name FROM drivers WHERE id = ?', row.driver_id);
  const tickets = all(
    'SELECT id, reason, status, resolution, created_at, resolved_at FROM tickets WHERE delivery_id = ? AND raised_by = \'customer\' ORDER BY created_at DESC',
    row.id,
  );
  return {
    id: row.id,
    status: row.status,
    address: row.address,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    failReason: row.fail_reason,
    riderName: firstName(driver ? driver.name : ''),
    trackToken: row.track_token,
    // The rider's helmet camera is on for this delivery right now.
    live: (row.status === 'assigned' || row.status === 'in_progress') && Boolean(live.forDelivery(row.id)),
    problems: tickets.map((ticket) => ({
      id: ticket.id,
      reason: ticket.reason,
      status: ticket.status,
      resolution: ticket.resolution,
      createdAt: ticket.created_at,
      resolvedAt: ticket.resolved_at,
    })),
  };
}

function ownDelivery(user, id) {
  const delivery = one('SELECT * FROM deliveries WHERE id = ? AND customer_user_id = ?', id, user.id);
  // The same answer whether the delivery is someone else's or does not exist.
  if (!delivery) throw new HttpError(404, 'Delivery not found');
  return delivery;
}

/** Endpoints for signed in customers. They only ever see deliveries linked to their account. */
function register(router) {
  const customer = auth.requireCustomer;

  router.get('/api/customer/deliveries', customer, ({ res, user }) => {
    const rows = all('SELECT * FROM deliveries WHERE customer_user_id = ? ORDER BY created_at DESC LIMIT 100', user.id);
    sendJson(res, 200, { deliveries: rows.map(present), problemTypes: PROBLEMS });
  });

  // Body: { problem: one of PROBLEMS, details }
  router.post('/api/customer/deliveries/:id/problems', customer, async ({ req, res, params, user }) => {
    auth.limit('customer-problem', req, 10, 60 * 60 * 1000);
    const delivery = ownDelivery(user, params.id);
    const body = parseJson(await readBody(req, config.maxJsonBytes));
    const label = PROBLEMS[body.problem];
    if (!label) throw new HttpError(400, 'Choose what went wrong');
    const details = typeof body.details === 'string' ? body.details.trim().slice(0, 800) : '';
    if (body.problem === 'other' && !details) throw new HttpError(400, 'Describe the problem');

    const open = one(
      'SELECT COUNT(*) AS n FROM tickets WHERE delivery_id = ? AND raised_by = \'customer\' AND status = \'open\'',
      delivery.id,
    ).n;
    if (open >= MAX_OPEN_PER_DELIVERY) {
      throw new HttpError(409, 'You already have problems open for this delivery. The team will reply to those first.');
    }

    const reason = details ? `${label}. ${details}` : label;
    const result = run(
      'INSERT INTO tickets (delivery_id, raised_by, reason, created_at) VALUES (?, \'customer\', ?, ?)',
      delivery.id, reason, Date.now(),
    );
    logEvent({
      deliveryId: delivery.id, source: 'customer', type: 'ticket_raised', actor: user.username,
      detail: label,
    });
    sendJson(res, 201, { id: Number(result.lastInsertRowid) });
  });
}

module.exports = { register };
