'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const { one, all, run, logEvent } = require('./db');
const { HttpError } = require('./http-utils');
const { RECORDING_ID, parseChunk, splitRecordingId, describeFlags } = require('./chunk-format');

const recordingsDir = path.join(config.dataDir, 'recordings');
const MAX_CHUNK_INDEX = 9999;

function dirFor(recordingId) {
  return path.join(recordingsDir, recordingId);
}

function chunkPath(recordingId, index) {
  return path.join(dirFor(recordingId), `${String(index).padStart(6, '0')}.hcv`);
}

function assertRecordingId(id) {
  if (!RECORDING_ID.test(id)) throw new HttpError(400, 'Invalid recording id');
}

/** Creates the recording row on first contact from either the phone or the helmet. */
function ensureRecording(recordingId, { deviceId = null, startedAt = Date.now() } = {}) {
  assertRecordingId(recordingId);
  const existing = one('SELECT * FROM recordings WHERE id = ?', recordingId);
  if (existing) {
    if (deviceId && !existing.device_id) {
      run('UPDATE recordings SET device_id = ? WHERE id = ?', deviceId, recordingId);
    }
    return existing;
  }
  const { deliveryId, attempt } = splitRecordingId(recordingId);
  run(
    `INSERT INTO recordings (id, delivery_id, attempt, device_id, status, started_at)
     VALUES (?, ?, ?, ?, 'receiving', ?)`,
    recordingId, deliveryId, attempt, deviceId, startedAt,
  );
  run('UPDATE deliveries SET attempts = MAX(attempts, ?) WHERE id = ?', attempt, deliveryId);
  return one('SELECT * FROM recordings WHERE id = ?', recordingId);
}

/** Validates and stores one uploaded chunk. Safe to call twice with the same chunk. */
function storeChunk(deviceId, buffer) {
  const parsed = parseChunk(buffer);
  if (!parsed) throw new HttpError(400, 'Not a valid HCV chunk');
  const { header, frames } = parsed;
  if (!RECORDING_ID.test(header.recordingId)) throw new HttpError(400, 'Invalid recording id in chunk');
  if (header.chunkIndex > MAX_CHUNK_INDEX) throw new HttpError(400, 'Chunk index out of range');

  const recordingId = header.recordingId;
  const recording = ensureRecording(recordingId, {
    deviceId,
    startedAt: header.startEpoch > 1600000000 ? header.startEpoch * 1000 : Date.now(),
  });

  fs.mkdirSync(dirFor(recordingId), { recursive: true });
  const target = chunkPath(recordingId, header.chunkIndex);
  const temporary = `${target}.part`;
  fs.writeFileSync(temporary, buffer);
  fs.renameSync(temporary, target);

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const durationMs = frames.length ? frames[frames.length - 1].t - frames[0].t : 0;
  run(
    `INSERT OR REPLACE INTO chunks
       (recording_id, idx, sha256, bytes, frames, duration_ms, start_epoch, flags, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    recordingId, header.chunkIndex, sha256, buffer.length, frames.length, durationMs,
    header.startEpoch, header.flags, Date.now(),
  );

  // A chunk arriving for a recording we had written off brings it back to life.
  const revived = recording.status === 'purged' || recording.status === 'expired';
  run(
    'UPDATE recordings SET flags = flags | ?, status = CASE WHEN ? THEN \'receiving\' ELSE status END WHERE id = ?',
    header.flags, revived ? 1 : 0, recordingId,
  );
  frameIndexCache.delete(recordingId);

  return { recordingId, index: header.chunkIndex, sha256, frames: frames.length };
}

/** The helmet reports that every chunk of a recording has been sent. */
function completeRecording(recordingId, deviceId, { chunks, interrupted }) {
  const recording = ensureRecording(recordingId, { deviceId });
  const expected = Number.isInteger(chunks) && chunks >= 0 ? chunks : null;
  const status = interrupted ? 'interrupted' : 'complete';
  run(
    'UPDATE recordings SET status = ?, expected_chunks = ?, completed_at = ? WHERE id = ?',
    status, expected, Date.now(), recordingId,
  );
  logEvent({
    deliveryId: recording.delivery_id, recordingId, source: 'device',
    type: interrupted ? 'recording_interrupted' : 'recording_stored',
    detail: expected === null ? null : `${expected} parts`,
  });
}

/** The helmet deleted a recording to free space before it could upload it. */
function markPurged(recordingId, deviceId) {
  const recording = ensureRecording(recordingId, { deviceId });
  const received = one('SELECT COUNT(*) AS n FROM chunks WHERE recording_id = ?', recordingId).n;
  if (recording.status === 'receiving' && received === 0) {
    run('UPDATE recordings SET status = \'purged\', completed_at = ? WHERE id = ?', Date.now(), recordingId);
  }
  logEvent({
    deliveryId: recording.delivery_id, recordingId, source: 'device', type: 'recording_purged',
    detail: 'Helmet memory card was full, so this recording was deleted before upload',
  });
}

const CHUNK_TOTALS = `
    (SELECT COUNT(*) FROM chunks c WHERE c.recording_id = r.id) AS received_chunks,
    (SELECT COALESCE(SUM(c.bytes), 0) FROM chunks c WHERE c.recording_id = r.id) AS bytes,
    (SELECT COALESCE(SUM(c.frames), 0) FROM chunks c WHERE c.recording_id = r.id) AS frames,
    (SELECT COALESCE(SUM(c.duration_ms), 0) FROM chunks c WHERE c.recording_id = r.id) AS duration_ms`;

const RECORDING_SELECT = `SELECT r.*, ${CHUNK_TOTALS} FROM recordings r`;

function presentRecording(row) {
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    attempt: row.attempt,
    deviceId: row.device_id,
    status: row.status,
    expectedChunks: row.expected_chunks,
    receivedChunks: row.received_chunks,
    bytes: row.bytes,
    frames: row.frames,
    durationMs: row.duration_ms,
    flags: describeFlags(row.flags),
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function recordingsForDelivery(deliveryId) {
  return all(`${RECORDING_SELECT} WHERE r.delivery_id = ? ORDER BY r.attempt`, deliveryId).map(presentRecording);
}

/** Every recording on the server, newest first, for the admin video library. */
function listAllRecordings({ q = '', status = '' } = {}) {
  const where = [];
  const params = [];
  if (q) {
    where.push('(r.id LIKE ? OR d.customer_name LIKE ? OR d.driver_id LIKE ? OR r.device_id LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (status) {
    where.push('r.status = ?');
    params.push(status);
  }
  const rows = all(
    `SELECT r.*, ${CHUNK_TOTALS},
       d.customer_name, d.driver_id,
       (SELECT COUNT(*) FROM tickets t WHERE t.delivery_id = r.delivery_id) AS tickets
     FROM recordings r LEFT JOIN deliveries d ON d.id = r.delivery_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY r.started_at DESC LIMIT 300`,
    ...params,
  );
  return rows.map((row) => ({
    ...presentRecording(row),
    // A helmet can upload for an ID the dashboard has never heard of, for
    // example during a bench test. Those have no delivery behind them.
    deliveryExists: row.customer_name !== null,
    customerName: row.customer_name,
    driverId: row.driver_id,
    tickets: row.tickets,
  }));
}

function storageTotals() {
  return {
    videos: one('SELECT COUNT(*) AS n FROM recordings WHERE status != \'expired\'').n,
    bytes: one('SELECT COALESCE(SUM(bytes), 0) AS n FROM chunks').n,
  };
}

// ---- Playback ---------------------------------------------------------------

const frameIndexCache = new Map();
const FRAME_INDEX_CACHE_SIZE = 16;

/** Locates every frame of a recording across its chunk files. */
function getFrameIndex(recordingId) {
  const cached = frameIndexCache.get(recordingId);
  if (cached) return cached;

  const rows = all('SELECT idx, start_epoch FROM chunks WHERE recording_id = ? ORDER BY idx', recordingId);
  const index = { startEpoch: rows.length ? rows[0].start_epoch : 0, lat: 0, lon: 0, frames: [] };
  rows.forEach((row, position) => {
    const file = chunkPath(recordingId, row.idx);
    if (!fs.existsSync(file)) return;
    const parsed = parseChunk(fs.readFileSync(file));
    if (!parsed) return;
    if (position === 0) {
      index.lat = parsed.header.lat;
      index.lon = parsed.header.lon;
    }
    for (const frame of parsed.frames) {
      index.frames.push({ t: frame.t, file, offset: frame.offset, length: frame.length });
    }
  });

  if (frameIndexCache.size >= FRAME_INDEX_CACHE_SIZE) {
    frameIndexCache.delete(frameIndexCache.keys().next().value);
  }
  frameIndexCache.set(recordingId, index);
  return index;
}

function readFrame(recordingId, number) {
  const frame = getFrameIndex(recordingId).frames[number];
  if (!frame) throw new HttpError(404, 'Frame not found');
  const jpeg = Buffer.alloc(frame.length);
  const fd = fs.openSync(frame.file, 'r');
  try {
    fs.readSync(fd, jpeg, 0, frame.length, frame.offset);
  } finally {
    fs.closeSync(fd);
  }
  return jpeg;
}

// ---- Retention ---------------------------------------------------------------

/** Deletes videos older than the retention period unless the delivery has a ticket. */
function expireOldRecordings() {
  const cutoff = Date.now() - config.retentionDays * 24 * 3600 * 1000;
  const rows = all(
    `SELECT r.id, r.delivery_id FROM recordings r
     WHERE r.status != 'expired'
       AND COALESCE(r.completed_at, r.started_at) < ?
       AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.delivery_id = r.delivery_id)`,
    cutoff,
  );
  for (const row of rows) {
    fs.rmSync(dirFor(row.id), { recursive: true, force: true });
    run('DELETE FROM chunks WHERE recording_id = ?', row.id);
    run('UPDATE recordings SET status = \'expired\' WHERE id = ?', row.id);
    frameIndexCache.delete(row.id);
    logEvent({
      deliveryId: row.delivery_id, recordingId: row.id, source: 'system', type: 'recording_expired',
      detail: `No ticket within ${config.retentionDays} days`,
    });
  }
  return rows.length;
}

module.exports = {
  ensureRecording, storeChunk, completeRecording, markPurged,
  recordingsForDelivery, listAllRecordings, storageTotals,
  getFrameIndex, readFrame, expireOldRecordings,
};
