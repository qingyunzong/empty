'use strict';

// WAL frame layout (append-only, one frame per committed transaction):
//   [0..4)   uint32 LE  payload length in bytes
//   [4..4+n) payload    UTF-8 JSON commit record
//   [4+n..8+n) uint32 LE CRC32 of payload
//
// A commit record carries the account balance update AND the usage records
// of the transaction in a single frame, so both are written (and recovered)
// atomically: they live and die together. A torn tail frame (crash mid-write)
// is detected via length/CRC and discarded on recovery.

const fs = require('node:fs');

const MAX_PAYLOAD = 64 * 1024 * 1024;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function encodeFrame(record) {
  const payload = Buffer.from(JSON.stringify(record), 'utf8');
  const frame = Buffer.allocUnsafe(8 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  frame.writeUInt32LE(crc32(payload), 4 + payload.length);
  return frame;
}

// Reads all intact frames from the WAL file. Stops at the first incomplete
// or corrupt frame (torn tail) and truncates the file back to the last good
// offset so future appends stay well-formed.
function recoverFrames(walPath) {
  if (!fs.existsSync(walPath)) return [];
  const buf = fs.readFileSync(walPath);
  const records = [];
  let offset = 0;
  let goodLength = 0;
  while (offset + 4 <= buf.length) {
    const len = buf.readUInt32LE(offset);
    if (len > MAX_PAYLOAD || offset + 8 + len > buf.length) break;
    const payload = buf.subarray(offset + 4, offset + 4 + len);
    const crc = buf.readUInt32LE(offset + 4 + len);
    if (crc32(payload) !== crc) break;
    records.push(JSON.parse(payload.toString('utf8')));
    offset += 8 + len;
    goodLength = offset;
  }
  if (goodLength < buf.length) {
    fs.truncateSync(walPath, goodLength);
  }
  return records;
}

module.exports = { encodeFrame, recoverFrames, crc32 };
