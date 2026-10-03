import { crc32 } from './crc32.js';
import { WalError } from './errors.js';

// Record framing: [u32le payloadLength][u32le crc32(payload)][payload(JSON utf8)]
// Payload: {txn, op, key, deviceId, oldValue, newValue}
export const HEADER_SIZE = 8;

export function encodeRecord(record) {
  const payload = Buffer.from(JSON.stringify(record), 'utf8');
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt32LE(payload.length, 0);
  header.writeUInt32LE(crc32(payload), 4);
  return Buffer.concat([header, payload]);
}

// Scan a whole WAL buffer. Never throws on corruption; instead reports the
// byte offset of the first unusable record so callers can decide policy
// (truncate-and-recover for writers, stop-and-report for readers).
export function scanWalBuffer(buf) {
  const records = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + HEADER_SIZE > buf.length) {
      return { records, corruptOffset: offset, reason: 'truncated-header' };
    }
    const length = buf.readUInt32LE(offset);
    const crc = buf.readUInt32LE(offset + 4);
    if (offset + HEADER_SIZE + length > buf.length) {
      return { records, corruptOffset: offset, reason: 'truncated-payload' };
    }
    const payload = buf.subarray(offset + HEADER_SIZE, offset + HEADER_SIZE + length);
    if (crc32(payload) !== crc) {
      return { records, corruptOffset: offset, reason: 'checksum' };
    }
    let record;
    try {
      record = JSON.parse(payload.toString('utf8'));
    } catch {
      return { records, corruptOffset: offset, reason: 'bad-json' };
    }
    records.push({ offset, record });
    offset += HEADER_SIZE + length;
  }
  return { records, corruptOffset: null, reason: null };
}

// Strict scan for read-only verification paths: throws CHECKSUM_MISMATCH
// carrying the byte offset of the first bad record.
export function scanWalStrict(buf) {
  const { records, corruptOffset, reason } = scanWalBuffer(buf);
  if (corruptOffset !== null) {
    throw new WalError(
      'CHECKSUM_MISMATCH',
      `WAL corruption (${reason}) at byte offset ${corruptOffset}`,
      { offset: corruptOffset, reason },
    );
  }
  return records;
}
