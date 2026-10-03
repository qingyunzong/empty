import { crc32 } from './crc32.js';
import { QcError, E } from './errors.js';

export const CHUNK_MAGIC = 'QCHK1';

// A chunk is: one JSON header line, then `bytes` payload bytes (JSONL records).
// The CRC32 covers exactly the payload bytes.
export function encodeChunk(index, records) {
  const payload = Buffer.from(records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  const header = {
    magic: CHUNK_MAGIC,
    index,
    records: records.length,
    bytes: payload.length,
    crc32: crc32(payload),
  };
  return Buffer.concat([Buffer.from(JSON.stringify(header) + '\n', 'utf8'), payload]);
}

export function decodeChunk(buf, expectedIndex) {
  const nl = buf.indexOf(0x0a);
  if (nl === -1) throw new QcError(E.CRC, 'chunk header line missing');
  let header;
  try {
    header = JSON.parse(buf.subarray(0, nl).toString('utf8'));
  } catch {
    throw new QcError(E.CRC, 'chunk header is not valid JSON');
  }
  if (
    !header ||
    header.magic !== CHUNK_MAGIC ||
    !Number.isInteger(header.records) ||
    !Number.isInteger(header.bytes) ||
    !Number.isInteger(header.crc32)
  ) {
    throw new QcError(E.CRC, 'chunk header fields invalid');
  }
  if (expectedIndex !== undefined && header.index !== expectedIndex) {
    throw new QcError(E.CRC, `chunk index mismatch: expected ${expectedIndex}, got ${header.index}`);
  }
  if (buf.length !== nl + 1 + header.bytes) {
    throw new QcError(E.CRC, 'chunk payload length mismatch');
  }
  const payload = buf.subarray(nl + 1);
  if (crc32(payload) !== header.crc32) {
    throw new QcError(E.CRC, 'chunk payload crc32 mismatch');
  }
  const lines = payload.toString('utf8').split('\n').filter((l) => l.length > 0);
  if (lines.length !== header.records) {
    throw new QcError(E.CRC, 'chunk record count mismatch');
  }
  return lines.map((l) => JSON.parse(l));
}
