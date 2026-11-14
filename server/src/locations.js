'use strict';

const { one, all, run } = require('./db');
const { HttpError } = require('./http-utils');

/** Points arriving faster than this from one sender are dropped. */
const MIN_INTERVAL_MS = 2000;

/** A rider position older than this is not shown to the customer. */
const RIDER_FRESH_MS = 10 * 60 * 1000;

function distanceMetres(lat1, lon1, lat2, lon2) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2
    + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(a));
}

/** Validates { lat, lon, accuracy?, speed?, heading? } from a request body. */
function parsePoint(body) {
  const lat = Number(body.lat);
  const lon = Number(body.lon);
  if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) {
    throw new HttpError(400, 'Position must have a valid lat and lon');
  }
  const optional = (value, max) => {
    const number = Number(value);
    return value !== null && value !== undefined && Number.isFinite(number) && number >= 0 && number <= max
      ? number
      : null;
  };
  return {
    lat,
    lon,
    accuracy: optional(body.accuracy, 100000),
    speed: optional(body.speed, 200),
    heading: optional(body.heading, 360),
  };
}

function latest(subject, subjectId) {
  return one(
    `SELECT lat, lon, accuracy, speed, heading, delivery_id, at FROM positions
     WHERE subject = ? AND subject_id = ? ORDER BY at DESC LIMIT 1`,
    subject, subjectId,
  );
}

/**
 * Stores a position. The time is the server's, so a phone with a wrong clock
 * cannot place a point in the past. Returns false when the point was dropped
 * for arriving too soon after the previous one.
 */
function record(subject, subjectId, deliveryId, point) {
  const now = Date.now();
  const previous = latest(subject, subjectId);
  if (previous && now - previous.at < MIN_INTERVAL_MS) return false;
  run(
    `INSERT INTO positions (subject, subject_id, delivery_id, lat, lon, accuracy, speed, heading, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    subject, subjectId, deliveryId, point.lat, point.lon, point.accuracy, point.speed, point.heading, now,
  );
  return true;
}

function present(row) {
  if (!row) return null;
  return {
    lat: row.lat,
    lon: row.lon,
    accuracy: row.accuracy,
    speed: row.speed,
    heading: row.heading,
    at: row.at,
  };
}

/** The rider's path for one delivery, oldest first. */
function route(deliveryId, limit = 5000) {
  return all(
    `SELECT lat, lon, at FROM positions WHERE subject = 'driver' AND delivery_id = ?
     ORDER BY at LIMIT ?`,
    deliveryId, limit,
  );
}

function isFresh(row, now = Date.now()) {
  return Boolean(row) && now - row.at <= RIDER_FRESH_MS;
}

/** Deletes every position older than the cutoff. Returns how many were removed. */
function expireBefore(cutoff) {
  return Number(run('DELETE FROM positions WHERE at < ?', cutoff).changes);
}

module.exports = {
  RIDER_FRESH_MS, distanceMetres, parsePoint, latest, record, present, route, isFresh, expireBefore,
};
