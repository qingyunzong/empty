import fs from 'node:fs';
import { crc32 } from './crc32.js';

export class LedgerError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// Block layout: [u32be payloadLen][payload bytes][u32be crc32(payload)]
const LEN_BYTES = 4;
const CRC_BYTES = 4;

export function encodeBlock(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const out = Buffer.alloc(LEN_BYTES + payload.length + CRC_BYTES);
  out.writeUInt32BE(payload.length, 0);
  payload.copy(out, LEN_BYTES);
  out.writeUInt32BE(crc32(payload), LEN_BYTES + payload.length);
  return out;
}

export function appendRecord(path, record) {
  const block = encodeBlock(record);
  const offset = fs.existsSync(path) ? fs.statSync(path).size : 0;
  const fd = fs.openSync(path, 'a');
  try {
    fs.writeSync(fd, block);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return { offset, bytes: block.length };
}

// Scans the whole log. Never throws on corruption; reports the first bad
// block offset so callers can decide (raise E_CRC, or truncate to recover).
export function scanLog(path) {
  const records = [];
  if (!fs.existsSync(path)) return { records, corruptOffset: null, reason: null };
  const buf = fs.readFileSync(path);
  let pos = 0;
  while (pos < buf.length) {
    if (pos + LEN_BYTES > buf.length) return { records, corruptOffset: pos, reason: 'truncated-header' };
    const len = buf.readUInt32BE(pos);
    const end = pos + LEN_BYTES + len + CRC_BYTES;
    if (end > buf.length) return { records, corruptOffset: pos, reason: 'truncated-payload' };
    const payload = buf.subarray(pos + LEN_BYTES, pos + LEN_BYTES + len);
    const expected = buf.readUInt32BE(pos + LEN_BYTES + len);
    if (crc32(payload) !== expected) return { records, corruptOffset: pos, reason: 'crc-mismatch' };
    records.push({ offset: pos, record: JSON.parse(payload.toString('utf8')) });
    pos = end;
  }
  return { records, corruptOffset: null, reason: null };
}

export function truncateLog(path, offset) {
  fs.truncateSync(path, offset);
}
