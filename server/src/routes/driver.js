'use strict';

const config = require('../config');
const { one, all, run, logEvent } = require('../db');
const { sendJson, readBody, parseJson, HttpError } = require('../http-utils');
const { requireDriver } = require('../auth');
const { RECORDING_ID, splitRecordingId } = require('../chunk-format');
const recordings = require('../recordings');
const locations = require('../locations');

const EVENT_TYPES = new Set([
  'delivery_started', 'geofence_enter', 'recording_started', 'recording_stopped', 'recording_restarted',
  'camera_disconnected', 'camera_reconnected', 'delivered_blocked',
]);

/** A completion further than this from the destination is flagged. */
const FAR_FROM_DESTINATION_METRES = 300;

function present(row) {
  return {
    id: row.id,
    customerName: row.customer_name,
    address: row.address,
    destLat: row.dest_lat,
    destLon: row.dest_lon,
    status: row.status,
    attempts: row.attempts,
    // Shown to the rider only if the customer chose to share it.
    customer: locations.present(locations.latest('customer', row.id)),
  };
}

/** Loads a delivery and checks it belongs to the calling driver. */
function ownDelivery(ctx) {
  const delivery = one('SELECT * FROM deliveries WHERE id = ?', ctx.params.id);
  if (!delivery) throw new HttpError(404, 'Delivery not found');
  if (delivery.driver_id !== ctx.driverId) throw new HttpError(403, 'Delivery belongs to another driver');
  return delivery;
}

/** Returns the recording id from the body if it is valid and belongs to this delivery. */
function recordingIdFor(delivery, value) {
  if (typeof value !== 'string' || !RECORDING_ID.test(value)) return null;
  return splitRecordingId(value).deliveryId === delivery.id ? value : null;
}

function timestamp(value) {
  return Number.isFinite(value) && value > 1600000000000 ? Math.round(value) : Date.now();
}

/** Endpoints called by the driver phone app. */
function register(router) {
  router.get('/api/driver/deliveries', requireDriver, (ctx) => {
    const rows = all(
      `SELECT * FROM deliveries WHERE driver_id = ? AND status IN ('assigned', 'in_progress')
       ORDER BY created_at`,
      ctx.driverId,
    );
    const driver = one('SELECT name FROM drivers WHERE id = ?', ctx.driverId);
    sendJson(ctx.res, 200, {
      driverId: ctx.driverId,
      driverName: driver ? driver.name : ctx.driverId,
      deliveries: rows.map(present),
    });
  });

  // Body: { type, recordingId?, detail?, at? }
  router.post('/api/driver/deliveries/:id/events', requireDriver, async (ctx) => {
    const delivery = ownDelivery(ctx);
    const body = parseJson(await readBody(ctx.req, config.maxJsonBytes));
    if (!EVENT_TYPES.has(body.type)) throw new HttpError(400, 'Unknown event type');
    const recordingId = recordingIdFor(delivery, body.recordingId);
    const at = timestamp(body.at);

    if ((body.type === 'recording_started' || body.type === 'recording_restarted') && recordingId) {
      recordings.ensureRecording(recordingId, { startedAt: at });
    }
    if (delivery.status === 'assigned') {
      run('UPDATE deliveries SET status = \'in_progress\' WHERE id = ?', delivery.id);
    }
    logEvent({
      deliveryId: delivery.id, recordingId, source: 'driver', type: body.type, at,
      detail: typeof body.detail === 'string' ? body.detail.slice(0, 300) : null,
    });
    sendJson(ctx.res, 200, { ok: true });
  });

  // Body: { recordingId, lat, lon, at? }
  router.post('/api/driver/deliveries/:id/complete', requireDriver, async (ctx) => {
    const delivery = ownDelivery(ctx);
    if (delivery.status === 'delivered') {
      sendJson(ctx.res, 200, { ok: true });
      return;
    }
    const body = parseJson(await readBody(ctx.req, config.maxJsonBytes));
    const recordingId = recordingIdFor(delivery, body.recordingId);
    const at = timestamp(body.at);
    const hasPosition = Number.isFinite(body.lat) && Number.isFinite(body.lon);

    run(
      `UPDATE deliveries SET status = 'delivered', delivered_at = ?, proof_recording = ?,
         completed_lat = ?, completed_lon = ? WHERE id = ?`,
      at, recordingId, hasPosition ? body.lat : null, hasPosition ? body.lon : null, delivery.id,
    );
    logEvent({ deliveryId: delivery.id, recordingId, source: 'driver', type: 'delivered', at });

    if (!recordingId) {
      logEvent({
        deliveryId: delivery.id, source: 'system', type: 'completed_without_recording', at,
        detail: 'The app marked this delivered with no active recording',
      });
    }
    if (hasPosition) {
      const metres = locations.distanceMetres(body.lat, body.lon, delivery.dest_lat, delivery.dest_lon);
      if (metres > FAR_FROM_DESTINATION_METRES) {
        logEvent({
          deliveryId: delivery.id, recordingId, source: 'system', type: 'completed_far_from_destination', at,
          detail: `Marked delivered ${Math.round(metres)} m from the destination`,
        });
      }
    }
    sendJson(ctx.res, 200, { ok: true });
  });

  // Body: { reason, recordingId?, at? }
  router.post('/api/driver/deliveries/:id/fail', requireDriver, async (ctx) => {
    const delivery = ownDelivery(ctx);
    const body = parseJson(await readBody(ctx.req, config.maxJsonBytes));
    const reason = typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim().slice(0, 300)
      : 'No reason given';
    const at = timestamp(body.at);
    run('UPDATE deliveries SET status = \'failed\', fail_reason = ?, delivered_at = ? WHERE id = ?',
      reason, at, delivery.id);
    logEvent({
      deliveryId: delivery.id, recordingId: recordingIdFor(delivery, body.recordingId),
      source: 'driver', type: 'delivery_failed', detail: reason, at,
    });
    sendJson(ctx.res, 200, { ok: true });
  });
}

module.exports = { register };
