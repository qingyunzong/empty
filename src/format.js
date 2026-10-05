'use strict';

const { crc32 } = require('./crc32');
const { QGError } = require('./errors');

// Block layout (little endian):
//   [0..3]  magic 'QGB1'
//   [4..7]  block id (uint32)
//   [8..11] payload length (uint32)
//   [12..15] crc32 of payload (uint32)
//   [16..]  payload: newline-delimited JSON records
const MAGIC = Buffer.from([0x51, 0x47, 0x42, 0x31]);
const HEADER_LEN = 16;

function encodeBlock(id, records) {
  const payload = Buffer.concat(
    records.map((r) => Buffer.from(JSON.stringify(r) + '\n', 'utf8'))
  );
  const header = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(header, 0);
  header.writeUInt32LE(id >>> 0, 4);
  header.writeUInt32LE(payload.length, 8);
  header.writeUInt32LE(crc32(payload), 12);
  return Buffer.concat([header, payload]);
}

// Returns { id, payloadLen, crc } or null when the magic is not present.
function parseHeader(buf) {
  if (buf.length < HEADER_LEN) return null;
  if (!buf.subarray(0, 4).equals(MAGIC)) return null;
  return {
    id: buf.readUInt32LE(4),
    payloadLen: buf.readUInt32LE(8),
    crc: buf.readUInt32LE(12),
  };
}

// Splits a block payload into records, tracking the byte offset of each
// record line inside the payload.
function parsePayload(payload) {
  const records = [];
  let start = 0;
  for (let i = 0; i <= payload.length; i++) {
    if (i === payload.length || payload[i] === 0x0a) {
      if (i > start) {
        const bytes = payload.subarray(start, i);
        let record;
        try {
          record = JSON.parse(bytes.toString('utf8'));
        } catch {
          throw new QGError('E_FORMAT', 'record line is not valid JSON');
        }
        records.push({ record, offset: start, bytes: Buffer.from(bytes) });
      }
      start = i + 1;
    }
  }
  return records;
}

module.exports = { MAGIC, HEADER_LEN, encodeBlock, parseHeader, parsePayload };
