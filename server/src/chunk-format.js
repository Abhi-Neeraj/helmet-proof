'use strict';

/**
 * HCV chunk format, shared by the helmet firmware, this server, and the simulator.
 * All integers are little endian.
 *
 *   Header (64 bytes)
 *     0   char[4]  magic "HCV1"
 *     4   uint16   flags (see FLAGS)
 *     6   uint16   header size (64)
 *     8   uint32   chunk index within the recording, starting at 0
 *     12  uint32   chunk start time, Unix seconds
 *     16  uint32   frame count
 *     20  uint32   chunk duration in milliseconds
 *     24  int32    latitude  x 1e7 at recording start
 *     28  int32    longitude x 1e7 at recording start
 *     32  char[32] recording id, zero padded
 *
 *   Then one record per frame
 *     uint32 milliseconds since the recording started
 *     uint32 JPEG length
 *     bytes  JPEG data
 */

const MAGIC = 'HCV1';
const HEADER_SIZE = 64;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;

const FLAGS = {
  LOW_DETAIL: 0x01,
  LINK_LOST: 0x02,
  TIMEOUT: 0x04,
  TIME_UNSYNCED: 0x08,
  CAMERA_FAULT: 0x10,
};

const FLAG_LABELS = [
  [FLAGS.LOW_DETAIL, 'Lens may have been covered, or the scene was very dark'],
  [FLAGS.LINK_LOST, 'Phone link dropped during recording'],
  [FLAGS.TIMEOUT, 'Recording hit the time limit'],
  [FLAGS.TIME_UNSYNCED, 'Helmet clock was not set'],
  [FLAGS.CAMERA_FAULT, 'Camera or memory card fault'],
];

/** Flags that suggest tampering and deserve a dashboard alert. */
const TAMPER_FLAGS = FLAGS.LOW_DETAIL | FLAGS.LINK_LOST | FLAGS.CAMERA_FAULT;

const RECORDING_ID = /^[A-Za-z0-9_-]{1,31}$/;
const DELIVERY_ID = /^[A-Za-z0-9_-]{1,24}$/;

function describeFlags(flags) {
  return FLAG_LABELS.filter(([bit]) => flags & bit).map(([, label]) => label);
}

/** "D1234-2" -> { deliveryId: "D1234", attempt: 2 }. */
function splitRecordingId(id) {
  const match = /^(.+)-(\d{1,3})$/.exec(id);
  if (!match) return { deliveryId: id, attempt: 1 };
  return { deliveryId: match[1], attempt: Number(match[2]) };
}

/**
 * Parses a chunk. Returns null when the header is invalid. A truncated final
 * frame (power lost while writing) is dropped rather than rejected.
 */
function parseChunk(buffer) {
  if (buffer.length < HEADER_SIZE || buffer.toString('latin1', 0, 4) !== MAGIC) return null;
  const headerSize = buffer.readUInt16LE(6);
  if (headerSize < HEADER_SIZE || headerSize > buffer.length) return null;

  const idBytes = buffer.subarray(32, 64);
  const idEnd = idBytes.indexOf(0);
  const header = {
    flags: buffer.readUInt16LE(4),
    chunkIndex: buffer.readUInt32LE(8),
    startEpoch: buffer.readUInt32LE(12),
    frameCount: buffer.readUInt32LE(16),
    durationMs: buffer.readUInt32LE(20),
    lat: buffer.readInt32LE(24) / 1e7,
    lon: buffer.readInt32LE(28) / 1e7,
    recordingId: idBytes.toString('latin1', 0, idEnd === -1 ? 32 : idEnd),
  };

  const frames = [];
  let offset = headerSize;
  while (offset + 8 <= buffer.length) {
    const t = buffer.readUInt32LE(offset);
    const length = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (length === 0 || length > MAX_FRAME_BYTES || start + length > buffer.length) break;
    // Every JPEG starts with FF D8. Anything else means the stream is corrupt.
    if (buffer[start] !== 0xff || buffer[start + 1] !== 0xd8) break;
    frames.push({ t, offset: start, length });
    offset = start + length;
  }

  return { header, frames, truncated: offset !== buffer.length };
}

/** Builds a chunk. Used by the simulator and tests. */
function buildChunk({ recordingId, chunkIndex, startEpoch, flags = 0, lat = 0, lon = 0, frames }) {
  const header = Buffer.alloc(HEADER_SIZE);
  header.write(MAGIC, 0, 'latin1');
  header.writeUInt16LE(flags, 4);
  header.writeUInt16LE(HEADER_SIZE, 6);
  header.writeUInt32LE(chunkIndex, 8);
  header.writeUInt32LE(startEpoch, 12);
  header.writeUInt32LE(frames.length, 16);
  const duration = frames.length ? frames[frames.length - 1].t - frames[0].t : 0;
  header.writeUInt32LE(duration, 20);
  header.writeInt32LE(Math.round(lat * 1e7), 24);
  header.writeInt32LE(Math.round(lon * 1e7), 28);
  header.write(recordingId, 32, 31, 'latin1');

  const parts = [header];
  for (const frame of frames) {
    const record = Buffer.alloc(8);
    record.writeUInt32LE(frame.t, 0);
    record.writeUInt32LE(frame.jpeg.length, 4);
    parts.push(record, frame.jpeg);
  }
  return Buffer.concat(parts);
}

module.exports = {
  FLAGS, TAMPER_FLAGS, RECORDING_ID, DELIVERY_ID,
  describeFlags, splitRecordingId, parseChunk, buildChunk,
};
