'use strict';

const { crc32 } = require('./crc32');
const { QlinError } = require('./errors');

const MAGIC = Buffer.from('QLIN0001', 'ascii');
const BLOCK_HEADER_SIZE = 8; // u32 payload length + u32 crc32

function encodeBlock(payload) {
  const block = Buffer.alloc(BLOCK_HEADER_SIZE + payload.length);
  block.writeUInt32LE(payload.length, 0);
  block.writeUInt32LE(crc32(payload), 4);
  payload.copy(block, BLOCK_HEADER_SIZE);
  return block;
}

// buf must contain exactly one full block (header + payload).
function decodeBlock(buf) {
  if (buf.length < BLOCK_HEADER_SIZE) {
    throw new QlinError('E_CRC', 'block too short');
  }
  const len = buf.readUInt32LE(0);
  const expectedCrc = buf.readUInt32LE(4);
  if (buf.length !== BLOCK_HEADER_SIZE + len) {
    throw new QlinError('E_CRC', 'block length mismatch');
  }
  const payload = buf.subarray(BLOCK_HEADER_SIZE);
  if (crc32(payload) !== expectedCrc) {
    throw new QlinError('E_CRC', 'block CRC32 mismatch');
  }
  return payload;
}

// Encode records as JSON lines; returns { payload, entries } where entries
// carry the payload-relative offset/length of each record line.
function encodeRecords(records) {
  const parts = [];
  const entries = [];
  let offset = 0;
  for (const rec of records) {
    const line = Buffer.from(JSON.stringify(rec) + '\n', 'utf8');
    entries.push({ lot: rec.lot, relOffset: offset, length: line.length });
    parts.push(line);
    offset += line.length;
  }
  return { payload: Buffer.concat(parts), entries };
}

// Parse a block payload back into records with payload-relative offsets.
function decodeRecords(payload) {
  const entries = [];
  let start = 0;
  while (start < payload.length) {
    let nl = payload.indexOf(0x0a, start);
    if (nl === -1) nl = payload.length;
    const line = payload.subarray(start, nl);
    if (line.length > 0) {
      let rec;
      try {
        rec = JSON.parse(line.toString('utf8'));
      } catch {
        throw new QlinError('E_CRC', 'record line is not valid JSON');
      }
      entries.push({ record: rec, relOffset: start, length: nl - start + (nl < payload.length ? 1 : 0) });
    }
    start = nl + 1;
  }
  return entries;
}

module.exports = { MAGIC, BLOCK_HEADER_SIZE, encodeBlock, decodeBlock, encodeRecords, decodeRecords };
