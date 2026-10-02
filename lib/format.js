'use strict';

const crypto = require('node:crypto');
const { crc32 } = require('./crc32');

const MAGIC = Buffer.from('TXRC01', 'ascii');
const HEADER_LEN = 6 + 8 + 32 + 4; // magic + seq + prevHash + payloadLen
const CRC_LEN = 4;
const MAX_PAYLOAD = 64 * 1024 * 1024;
const GENESIS_PREV = Buffer.alloc(32, 0);

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

function blockHash(header, payload) {
  return sha256(Buffer.concat([header, payload]));
}

function encodeBlock({ seq, prevHash, payload }) {
  const header = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(header, 0);
  header.writeBigUInt64LE(BigInt(seq), 6);
  Buffer.from(prevHash).copy(header, 14);
  header.writeUInt32LE(payload.length, 46);
  const crcBuf = Buffer.alloc(CRC_LEN);
  crcBuf.writeUInt32LE(crc32(payload), 0);
  return { bytes: Buffer.concat([header, payload, crcBuf]), header };
}

function decodeBlockAt(buf, offset) {
  if (offset + HEADER_LEN > buf.length) {
    return { ok: false, reason: 'INCOMPLETE', offset };
  }
  const header = buf.subarray(offset, offset + HEADER_LEN);
  if (!header.subarray(0, 6).equals(MAGIC)) {
    return { ok: false, reason: 'CORRUPT', offset, detail: 'bad magic' };
  }
  const seq = Number(header.readBigUInt64LE(6));
  const prevHash = Buffer.from(header.subarray(14, 46));
  const payloadLen = header.readUInt32LE(46);
  if (payloadLen > MAX_PAYLOAD) {
    return { ok: false, reason: 'CORRUPT', offset, detail: `wild payload length ${payloadLen}` };
  }
  const end = offset + HEADER_LEN + payloadLen + CRC_LEN;
  if (end > buf.length) {
    return { ok: false, reason: 'INCOMPLETE', offset, payloadLen };
  }
  const payload = buf.subarray(offset + HEADER_LEN, offset + HEADER_LEN + payloadLen);
  const crc = buf.readUInt32LE(offset + HEADER_LEN + payloadLen);
  if (crc32(payload) !== crc) {
    return { ok: false, reason: 'INCOMPLETE', offset, detail: 'crc mismatch (length field or payload damaged)' };
  }
  return {
    ok: true,
    offset,
    seq,
    prevHash,
    payload: Buffer.from(payload),
    hash: blockHash(header, payload),
    nextOffset: end,
  };
}

function encodePayload(records) {
  return Buffer.from(JSON.stringify(records), 'utf8');
}

function decodePayload(payload) {
  try {
    const records = JSON.parse(payload.toString('utf8'));
    if (!Array.isArray(records)) return { ok: false, reason: 'CORRUPT', detail: 'payload not an array' };
    return { ok: true, records };
  } catch {
    return { ok: false, reason: 'CORRUPT', detail: 'payload not valid JSON' };
  }
}

module.exports = {
  MAGIC,
  HEADER_LEN,
  CRC_LEN,
  MAX_PAYLOAD,
  GENESIS_PREV,
  sha256,
  blockHash,
  encodeBlock,
  decodeBlockAt,
  encodePayload,
  decodePayload,
};
