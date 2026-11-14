'use strict';

const config = require('../config');
const { sendJson, readBody, parseJson, HttpError } = require('../http-utils');
const { verifyDevice } = require('../auth');
const { RECORDING_ID } = require('../chunk-format');
const recordings = require('../recordings');
const live = require('../live');

/** A live frame is one JPEG; far smaller than this. */
const MAX_LIVE_BYTES = 1024 * 1024;

/** Reads a signed JSON body from the helmet and returns { deviceId, body }. */
async function signedJson(req) {
  const raw = await readBody(req, config.maxJsonBytes);
  const deviceId = verifyDevice(req, raw);
  const body = parseJson(raw);
  if (typeof body.id !== 'string' || !RECORDING_ID.test(body.id)) {
    throw new HttpError(400, 'Invalid recording id');
  }
  return { deviceId, body };
}

/** Endpoints called by the helmet. Every request is signed with the device secret. */
function register(router) {
  // Body is one raw HCV chunk. The recording id and chunk index are inside it.
  router.post('/api/device/chunks', async ({ req, res }) => {
    const raw = await readBody(req, config.maxChunkBytes);
    const deviceId = verifyDevice(req, raw);
    sendJson(res, 200, { ok: true, ...recordings.storeChunk(deviceId, raw) });
  });

  // Body: { id, chunks, interrupted }
  router.post('/api/device/complete', async ({ req, res }) => {
    const { deviceId, body } = await signedJson(req);
    recordings.completeRecording(body.id, deviceId, {
      chunks: body.chunks,
      interrupted: Boolean(body.interrupted),
    });
    sendJson(res, 200, { ok: true });
  });

  // Body: { id }
  router.post('/api/device/purged', async ({ req, res }) => {
    const { deviceId, body } = await signedJson(req);
    recordings.markPurged(body.id, deviceId);
    sendJson(res, 200, { ok: true });
  });

  // Body: "<recording id>\n" followed by one JPEG frame, signed like every
  // other helmet request. The answer tells the helmet whether anyone is
  // watching, so it can send often for a viewer and rarely otherwise.
  router.post('/api/device/live', async ({ req, res }) => {
    const raw = await readBody(req, MAX_LIVE_BYTES);
    const deviceId = verifyDevice(req, raw);
    const newline = raw.indexOf(10);
    if (newline < 1 || newline > 40) throw new HttpError(400, 'Missing recording id');
    const recordingId = raw.toString('latin1', 0, newline);
    if (!RECORDING_ID.test(recordingId)) throw new HttpError(400, 'Invalid recording id');
    const jpeg = Buffer.from(raw.subarray(newline + 1));
    if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new HttpError(400, 'Not a JPEG frame');
    const watching = live.publish(deviceId, recordingId, jpeg);
    sendJson(res, 200, { ok: true, watching });
  });
}

module.exports = { register };
