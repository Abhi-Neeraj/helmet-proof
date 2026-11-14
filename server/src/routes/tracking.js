'use strict';

const config = require('../config');
const { one, all } = require('../db');
const { sendJson, readBody, parseJson, HttpError } = require('../http-utils');
const auth = require('../auth');
const locations = require('../locations');
const live = require('../live');
const { logEvent } = require('../db');

const MINUTE = 60 * 1000;
const OPEN_STATUSES = new Set(['assigned', 'in_progress']);

/** The delivery a rider's position belongs to: the one named, if it is theirs, or their current one. */
function deliveryForDriver(driverId, requestedId) {
  if (typeof requestedId === 'string' && requestedId) {
    const named = one(
      'SELECT id FROM deliveries WHERE id = ? AND driver_id = ? AND status IN (\'assigned\', \'in_progress\')',
      requestedId, driverId,
    );
    if (named) return named.id;
  }
  const current = one(
    `SELECT id FROM deliveries WHERE driver_id = ? AND status = 'in_progress'
     ORDER BY created_at DESC LIMIT 1`,
    driverId,
  );
  return current ? current.id : null;
}

function deliveryByToken(token) {
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(token)) throw new HttpError(404, 'This tracking link is not valid');
  const delivery = one('SELECT * FROM deliveries WHERE track_token = ?', token);
  if (!delivery) throw new HttpError(404, 'This tracking link is not valid');
  return delivery;
}

/** What the customer may see about their own delivery. */
function trackingView(delivery) {
  const now = Date.now();
  const rider = locations.latest('driver', delivery.driver_id);
  const showRider = delivery.status === 'in_progress' && locations.isFresh(rider, now);
  let state = 'not_started';
  if (delivery.status === 'delivered') state = 'delivered';
  else if (delivery.status === 'failed') state = 'failed';
  else if (delivery.status === 'in_progress') state = showRider ? 'on_the_way' : 'no_signal';

  return {
    delivery: {
      id: delivery.id,
      status: delivery.status,
      address: delivery.address,
      destLat: delivery.dest_lat,
      destLon: delivery.dest_lon,
      // First name only. The page is reachable by anyone holding the link.
      greeting: String(delivery.customer_name).trim().split(/\s+/)[0],
    },
    state,
    rider: showRider ? locations.present(rider) : null,
    you: OPEN_STATUSES.has(delivery.status) ? locations.present(locations.latest('customer', delivery.id)) : null,
    canShare: OPEN_STATUSES.has(delivery.status),
    // The helmet camera of this delivery's rider is on and sending.
    live: OPEN_STATUSES.has(delivery.status) && Boolean(live.forDelivery(delivery.id)),
    now,
  };
}

/** Live locations: riders' phones, customers' tracking links, and the staff map. */
function register(router) {
  const body = async (req) => parseJson(await readBody(req, config.maxJsonBytes));

  // ---- Driver phone ------------------------------------------------------------

  // Body: { lat, lon, accuracy?, speed?, heading?, deliveryId? }
  router.post('/api/driver/location', auth.requireDriver, async (ctx) => {
    const input = await body(ctx.req);
    const point = locations.parsePoint(input);
    const deliveryId = deliveryForDriver(ctx.driverId, input.deliveryId);
    const stored = locations.record('driver', ctx.driverId, deliveryId, point);
    sendJson(ctx.res, 200, { ok: true, stored, deliveryId });
  });

  // ---- Customer tracking link (public; the token is the only key) --------------

  router.get('/api/track/:token', ({ req, res, params }) => {
    auth.limit('track', req, 120, MINUTE);
    sendJson(res, 200, trackingView(deliveryByToken(params.token)));
  });

  // Body: { lat, lon, accuracy? }. Only while the delivery is still open.
  router.post('/api/track/:token/location', async ({ req, res, params }) => {
    auth.limit('track-share', req, 60, MINUTE);
    const delivery = deliveryByToken(params.token);
    if (!OPEN_STATUSES.has(delivery.status)) {
      throw new HttpError(409, 'This delivery is finished, so your location is no longer needed');
    }
    const point = locations.parsePoint(await body(req));
    const stored = locations.record('customer', delivery.id, delivery.id, point);
    sendJson(res, 200, { ok: true, stored });
  });

  // ---- Staff dashboard -----------------------------------------------------------

  router.get('/api/live', auth.requireStaff, ({ res }) => {
    const drivers = all('SELECT id, name FROM drivers WHERE disabled = 0 ORDER BY created_at').map((driver) => {
      const current = one(
        `SELECT id FROM deliveries WHERE driver_id = ? AND status = 'in_progress'
         ORDER BY created_at DESC LIMIT 1`,
        driver.id,
      );
      return {
        id: driver.id,
        name: driver.name,
        position: locations.present(locations.latest('driver', driver.id)),
        deliveryId: current ? current.id : null,
      };
    });
    const deliveries = all(
      `SELECT * FROM deliveries WHERE status IN ('assigned', 'in_progress')
       ORDER BY created_at DESC LIMIT 200`,
    ).map((delivery) => ({
      id: delivery.id,
      customerName: delivery.customer_name,
      address: delivery.address,
      destLat: delivery.dest_lat,
      destLon: delivery.dest_lon,
      status: delivery.status,
      driverId: delivery.driver_id,
      customer: locations.present(locations.latest('customer', delivery.id)),
    }));
    sendJson(res, 200, { drivers, deliveries, liveNow: live.liveNow(), now: Date.now() });
  });

  router.get('/api/deliveries/:id/route', auth.requireStaff, ({ res, params }) => {
    const delivery = one('SELECT * FROM deliveries WHERE id = ?', params.id);
    if (!delivery) throw new HttpError(404, 'Delivery not found');
    const open = OPEN_STATUSES.has(delivery.status);
    sendJson(res, 200, {
      status: delivery.status,
      destination: { lat: delivery.dest_lat, lon: delivery.dest_lon },
      route: locations.route(delivery.id),
      // The rider's live dot only means something while the delivery is open.
      rider: open ? locations.present(locations.latest('driver', delivery.driver_id)) : null,
      customer: locations.present(locations.latest('customer', delivery.id)),
      live: live.summary(live.forDelivery(delivery.id)),
      now: Date.now(),
    });
  });

  // ---- Live camera ---------------------------------------------------------------
  // Each request waits for the next frame after `after` (see live.js).

  const afterParam = (url) => Math.max(0, Number(url.searchParams.get('after')) || 0);

  // Staff: the camera recording this delivery. Opening it is written on the timeline.
  router.get('/api/deliveries/:id/live', auth.requireStaff, async ({ res, params, url, user }) => {
    const delivery = one('SELECT id FROM deliveries WHERE id = ?', params.id);
    if (!delivery) throw new HttpError(404, 'Delivery not found');
    if (url.searchParams.get('start') === '1') {
      logEvent({ deliveryId: delivery.id, source: 'staff', type: 'live_opened', actor: user.username });
    }
    await live.serve(res, { deliveryId: delivery.id, after: afterParam(url) });
  });

  // Staff: one helmet, whatever it is recording.
  router.get('/api/helmets/:id/live', auth.requireStaff, async ({ res, params, url }) => {
    if (!one('SELECT id FROM devices WHERE id = ?', params.id)) throw new HttpError(404, 'Helmet not found');
    await live.serve(res, { deviceId: params.id, after: afterParam(url) });
  });

  // Customer: only the camera recording their own delivery, and only while it is open.
  router.get('/api/track/:token/live', async ({ req, res, params, url }) => {
    auth.limit('track-live', req, 900, MINUTE);
    const delivery = deliveryByToken(params.token);
    if (!OPEN_STATUSES.has(delivery.status)) throw new HttpError(409, 'This delivery is finished, so the live camera is off');
    await live.serve(res, { deliveryId: delivery.id, after: afterParam(url) });
  });
}

module.exports = { register, deliveryForDriver };
