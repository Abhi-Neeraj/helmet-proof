'use strict';

// Developer test tool. Pretends to be a driver phone and a helmet, so the whole
// flow can be exercised with no hardware. Run it on the machine the server runs
// on: it reads the helmet secret and the driver token straight from the database.
//
// The delivery must already exist in the dashboard, and at least one helmet
// must be registered under Admin > Helmets.
//
//   npm run simulate -- --delivery D123456
//   npm run simulate -- --delivery D123456 --seconds 25 --covered --no-deliver
//
// Options
//   --delivery <id>   delivery to record for (required)
//   --device <id>     helmet to upload as (default: the first registered helmet)
//   --attempt <n>     attempt number, default 1
//   --seconds <n>     clip length, default 20
//   --server <url>    default http://localhost:<PORT>
//   --covered         flag the clip as a possible covered lens
//   --interrupted     report the recording as cut short
//   --drop-last       skip uploading the final chunk, to test gap detection
//   --no-deliver      do not mark the delivery as delivered

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../src/config');
const { one } = require('../src/db');
const { buildChunk, FLAGS } = require('../src/chunk-format');

const FPS = 10;
const CHUNK_SECONDS = 10;

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const next = process.argv[at + 1];
  return next && !next.startsWith('--') ? next : true;
}

async function post(url, { headers = {}, body }) {
  const response = await fetch(url, { method: 'POST', headers, body });
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} -> ${response.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

async function main() {
  const deliveryId = option('delivery');
  if (!deliveryId || deliveryId === true) {
    console.error('Usage: npm run simulate -- --delivery <id>');
    process.exit(1);
  }
  const server = option('server', `http://localhost:${config.port}`);
  const attempt = Number(option('attempt', 1));
  const seconds = Number(option('seconds', 20));
  const recordingId = `${deliveryId}-${attempt}`;

  const delivery = one('SELECT * FROM deliveries WHERE id = ?', deliveryId);
  if (!delivery) throw new Error(`Delivery ${deliveryId} does not exist. Create it in the dashboard first.`);
  const driver = one('SELECT * FROM drivers WHERE id = ?', delivery.driver_id);
  if (!driver) throw new Error(`Driver ${delivery.driver_id} does not exist.`);
  const deviceId = option('device');
  const device = deviceId
    ? one('SELECT * FROM devices WHERE id = ?', deviceId)
    : one('SELECT * FROM devices WHERE disabled = 0 ORDER BY created_at LIMIT 1');
  if (!device) throw new Error('No helmet is registered. Add one under Admin > Helmets first.');

  const driverHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${driver.token}` };
  const sign = (body) => crypto.createHmac('sha256', device.secret).update(body).digest('hex');
  const deviceHeaders = (body, type) => ({
    'Content-Type': type, 'X-Device-Id': device.id, 'X-Signature': sign(body),
  });

  const framesDir = path.join(__dirname, 'sample-frames');
  const jpegs = fs.readdirSync(framesDir).filter((name) => name.endsWith('.jpg')).sort()
    .map((name) => fs.readFileSync(path.join(framesDir, name)));
  if (!jpegs.length) throw new Error(`No .jpg files in ${framesDir}`);

  const lat = delivery.dest_lat;
  const lon = delivery.dest_lon;

  // Phone: the driver entered the 200 m zone and told the helmet to start.
  const startedAt = Date.now() - seconds * 1000;
  await post(`${server}/api/driver/deliveries/${deliveryId}/events`, {
    headers: driverHeaders,
    body: JSON.stringify({ type: 'recording_started', recordingId, at: startedAt }),
  });

  // Helmet: build the chunks exactly as the firmware writes them.
  const totalFrames = seconds * FPS;
  const perChunk = CHUNK_SECONDS * FPS;
  const chunkCount = Math.ceil(totalFrames / perChunk);
  const flags = option('covered', false) ? FLAGS.LOW_DETAIL : 0;
  const uploadCount = option('drop-last', false) ? chunkCount - 1 : chunkCount;

  for (let index = 0; index < uploadCount; index += 1) {
    const frames = [];
    for (let n = index * perChunk; n < Math.min((index + 1) * perChunk, totalFrames); n += 1) {
      frames.push({ t: Math.round((n * 1000) / FPS), jpeg: jpegs[n % jpegs.length] });
    }
    const chunk = buildChunk({
      recordingId, chunkIndex: index, flags, frames,
      startEpoch: Math.floor(startedAt / 1000) + index * CHUNK_SECONDS,
      lat, lon,
    });
    const result = await post(`${server}/api/device/chunks`, {
      headers: deviceHeaders(chunk, 'application/octet-stream'), body: chunk,
    });
    console.log(`Uploaded chunk ${index + 1}/${chunkCount} (${chunk.length} bytes, ${result.frames} frames)`);
  }

  const complete = JSON.stringify({
    id: recordingId, chunks: chunkCount, interrupted: Boolean(option('interrupted', false)),
  });
  await post(`${server}/api/device/complete`, {
    headers: deviceHeaders(complete, 'application/json'), body: complete,
  });

  if (!option('no-deliver', false)) {
    await post(`${server}/api/driver/deliveries/${deliveryId}/complete`, {
      headers: driverHeaders,
      body: JSON.stringify({ recordingId, lat, lon, at: Date.now() }),
    });
  }
  console.log(`Recording ${recordingId} stored as helmet ${device.id}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
