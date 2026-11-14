'use strict';

const { splitRecordingId } = require('./chunk-format');

/*
 * Live view from the helmet cameras.
 *
 * While a helmet records, it also posts single JPEG frames here. Only the
 * newest frame per helmet is kept, in memory; nothing live is ever written to
 * disk (the recording itself is the evidence). Each frame carries the
 * recording id, "<delivery id>-<attempt>", so a frame belongs to exactly one
 * delivery and is only ever shown to people allowed to see that delivery.
 *
 * Viewers ask for "the next frame after N". The request waits until a newer
 * frame arrives, so the picture updates as soon as the helmet sends one.
 */

const FRESH_MS = 12000;   // a helmet silent for longer than this is not live
const WATCH_MS = 8000;    // a viewer who asked within this long counts as watching
const WAIT_MS = 10000;    // how long a viewer's request waits for a new frame

const latest = new Map();     // helmet id -> newest frame
const waiters = new Map();    // helmet id -> Set of callbacks waiting for a frame
const watchedAt = new Map();  // helmet id -> when a viewer last asked
let sequence = 0;

const isFresh = (frame, now = Date.now()) => Boolean(frame) && now - frame.at <= FRESH_MS;

function isWatched(deviceId) {
  const at = watchedAt.get(deviceId);
  return Boolean(at) && Date.now() - at <= WATCH_MS;
}

/** Stores a frame from a helmet and wakes everyone waiting. Returns whether anyone is watching. */
function publish(deviceId, recordingId, jpeg) {
  const frame = {
    deviceId,
    recordingId,
    deliveryId: splitRecordingId(recordingId).deliveryId,
    jpeg,
    seq: ++sequence,
    at: Date.now(),
  };
  latest.set(deviceId, frame);
  const waiting = waiters.get(deviceId);
  if (waiting) {
    waiters.delete(deviceId);
    for (const wake of waiting) wake(frame);
  }
  return isWatched(deviceId);
}

/** The helmet's newest frame if it is live, otherwise null. */
function forDevice(deviceId) {
  const frame = latest.get(deviceId);
  return isFresh(frame) ? frame : null;
}

/** The newest live frame recorded for this delivery, from whichever helmet records it. */
function forDelivery(deliveryId) {
  for (const frame of latest.values()) {
    if (frame.deliveryId === deliveryId && isFresh(frame)) return frame;
  }
  return null;
}

/** Every helmet that is live right now. */
function liveNow() {
  return [...latest.values()].filter((frame) => isFresh(frame)).map(summary);
}

function summary(frame) {
  return frame ? { deviceId: frame.deviceId, recordingId: frame.recordingId, deliveryId: frame.deliveryId, at: frame.at } : null;
}

function nextFrame(deviceId, after, res) {
  const frame = latest.get(deviceId);
  if (frame && frame.seq > after && isFresh(frame)) return Promise.resolve(frame);
  return new Promise((resolve) => {
    let waiting = waiters.get(deviceId);
    if (!waiting) {
      waiting = new Set();
      waiters.set(deviceId, waiting);
    }
    const done = (next) => {
      clearTimeout(timer);
      waiting.delete(done);
      resolve(next);
    };
    const timer = setTimeout(() => done(null), WAIT_MS);
    waiting.add(done);
    res.on('close', () => done(null));  // the viewer went away
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Answers a viewer with the next frame newer than `after`.
 * With `deliveryId`, only frames recorded for that delivery are sent.
 *   200 image/jpeg   a frame, with X-Frame-Seq, X-Frame-At, X-Recording-Id
 *   204 X-Live: off  the camera is not live for this delivery (asked again in a moment)
 */
async function serve(res, { deviceId = null, deliveryId = null, after = 0 }) {
  let current = deviceId ? forDevice(deviceId) : forDelivery(deliveryId);
  if (!current) {
    // Not live. Pause briefly so a waiting viewer does not ask in a tight loop.
    await sleep(2000);
    current = deviceId ? forDevice(deviceId) : forDelivery(deliveryId);
    if (!current) {
      if (!res.writableEnded) {
        res.writeHead(204, { 'Cache-Control': 'no-store', 'X-Live': 'off' });
        res.end();
      }
      return;
    }
  }

  watchedAt.set(current.deviceId, Date.now());
  const frame = await nextFrame(current.deviceId, after, res);
  if (res.writableEnded || res.destroyed) return;
  if (!frame || (deliveryId && frame.deliveryId !== deliveryId)) {
    res.writeHead(204, { 'Cache-Control': 'no-store', 'X-Live': frame ? 'off' : 'waiting' });
    res.end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': frame.jpeg.length,
    'Cache-Control': 'no-store',
    'X-Frame-Seq': String(frame.seq),
    'X-Frame-At': String(frame.at),
    'X-Recording-Id': frame.recordingId,
  });
  res.end(frame.jpeg);
}

// Forget helmets that stopped sending a while ago, so their last picture
// does not stay in memory.
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [deviceId, frame] of latest) if (frame.at < cutoff) latest.delete(deviceId);
  for (const [deviceId, at] of watchedAt) if (at < cutoff) watchedAt.delete(deviceId);
}, 60 * 1000).unref();

module.exports = { publish, forDevice, forDelivery, liveNow, summary, serve };
