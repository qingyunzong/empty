import { createHash } from 'node:crypto';
import { CODES } from './errors.js';

// On-disk layout of one page (all integers big-endian):
//   [0..8)    magic "ALPG0001"
//   [8..12)   pageSize  uint32 (self-describing, used by recovery)
//   [12..16)  version   uint32 (=1)
//   [16..24)  pageIndex uint64
//   [24..32)  firstSeq  uint64 (global seq of first event in page)
//   [32..34)  eventCount uint16
//   [34..36)  reserved (zero)
//   [36..40)  payloadLen uint32
//   [40..72)  prevHash  32 bytes (pageHash of previous page, genesis = zeros)
//   [72..pageSize-32)  payload (JSONL events) + zero padding
//   [pageSize-32..pageSize)  payloadHash = sha256(payload)
//
// Each page is followed by a 48-byte commit record:
//   [0..8)    magic "ALCM0001"
//   [8..16)   pageIndex uint64
//   [16..48)  pageHash = sha256(full page bytes)
// A page is committed iff its commit record is present and valid; the
// commit record is written together with the page and made durable by one
// fsync, which is the commit point.

export const PAGE_MAGIC = Buffer.from('ALPG0001', 'utf8');
export const COMMIT_MAGIC = Buffer.from('ALCM0001', 'utf8');
export const VERSION = 1;
export const HEADER_SIZE = 72;
export const TRAILER_SIZE = 32;
export const COMMIT_SIZE = 48;
export const MIN_PAGE_SIZE = 256;
export const MAX_PAGE_SIZE = 1 << 20;
export const GENESIS_HASH = Buffer.alloc(32);
export const EMPTY_ROOT = createHash('sha256').update(Buffer.alloc(0)).digest('hex');

export function sha256(buf) {
  return createHash('sha256').update(buf).digest();
}

export function payloadCapacity(pageSize) {
  return pageSize - HEADER_SIZE - TRAILER_SIZE;
}

export function stride(pageSize) {
  return pageSize + COMMIT_SIZE;
}

export function pageHash(pageBuf) {
  return sha256(pageBuf);
}

export function encodePage({ pageIndex, firstSeq, eventCount, payload, prevHash, pageSize }) {
  if (payload.length > payloadCapacity(pageSize)) {
    throw new RangeError('payload exceeds page capacity');
  }
  const buf = Buffer.alloc(pageSize);
  PAGE_MAGIC.copy(buf, 0);
  buf.writeUInt32BE(pageSize, 8);
  buf.writeUInt32BE(VERSION, 12);
  buf.writeBigUInt64BE(BigInt(pageIndex), 16);
  buf.writeBigUInt64BE(BigInt(firstSeq), 24);
  buf.writeUInt16BE(eventCount, 32);
  buf.writeUInt32BE(payload.length, 36);
  prevHash.copy(buf, 40);
  payload.copy(buf, HEADER_SIZE);
  sha256(payload).copy(buf, pageSize - TRAILER_SIZE);
  return buf;
}

export function decodePage(buf) {
  return {
    pageSize: buf.readUInt32BE(8),
    version: buf.readUInt32BE(12),
    pageIndex: Number(buf.readBigUInt64BE(16)),
    firstSeq: Number(buf.readBigUInt64BE(24)),
    eventCount: buf.readUInt16BE(32),
    payloadLen: buf.readUInt32BE(36),
    prevHash: Buffer.from(buf.subarray(40, 72)),
    payload: Buffer.from(buf.subarray(HEADER_SIZE, HEADER_SIZE + buf.readUInt32BE(36))),
    payloadHash: Buffer.from(buf.subarray(buf.length - TRAILER_SIZE)),
  };
}

// Returns null when valid, otherwise a violation object.
export function validatePage(buf, { expectedIndex, expectedPrevHash, expectedFirstSeq }) {
  const at = { page: expectedIndex };
  if (!buf.subarray(0, 8).equals(PAGE_MAGIC)) {
    return { code: CODES.CORRUPT, ...at, detail: 'bad page magic' };
  }
  if (buf.readUInt32BE(8) !== buf.length) {
    return { code: CODES.CORRUPT, ...at, detail: 'page size field mismatch' };
  }
  if (buf.readUInt32BE(12) !== VERSION) {
    return { code: CODES.CORRUPT, ...at, detail: 'unsupported page version' };
  }
  if (Number(buf.readBigUInt64BE(16)) !== expectedIndex) {
    return { code: CODES.CORRUPT, ...at, detail: 'page index mismatch' };
  }
  if (!buf.subarray(40, 72).equals(expectedPrevHash)) {
    return { code: CODES.CORRUPT, ...at, detail: 'hash chain broken (prevHash)' };
  }
  const payloadLen = buf.readUInt32BE(36);
  if (payloadLen > payloadCapacity(buf.length)) {
    return { code: CODES.CORRUPT, ...at, detail: 'payload length out of bounds' };
  }
  const payload = buf.subarray(HEADER_SIZE, HEADER_SIZE + payloadLen);
  if (!buf.subarray(buf.length - TRAILER_SIZE).equals(sha256(payload))) {
    return { code: CODES.CORRUPT, ...at, detail: 'payload hash mismatch' };
  }
  if (buf.readUInt16BE(32) === 0) {
    return { code: CODES.CORRUPT, ...at, detail: 'page with zero events' };
  }
  if (Number(buf.readBigUInt64BE(24)) !== expectedFirstSeq) {
    return {
      code: CODES.SEQ_GAP,
      ...at,
      detail: `expected firstSeq ${expectedFirstSeq}, got ${Number(buf.readBigUInt64BE(24))}`,
    };
  }
  return null;
}

export function encodeCommit({ pageIndex, hash }) {
  const buf = Buffer.alloc(COMMIT_SIZE);
  COMMIT_MAGIC.copy(buf, 0);
  buf.writeBigUInt64BE(BigInt(pageIndex), 8);
  hash.copy(buf, 16);
  return buf;
}

// Returns null when valid, otherwise a violation object.
export function validateCommit(buf, expectedIndex, expectedHash) {
  const at = { page: expectedIndex };
  if (buf.length < COMMIT_SIZE || !buf.subarray(0, 8).equals(COMMIT_MAGIC)) {
    return { code: CODES.CORRUPT, ...at, detail: 'missing commit record (uncommitted page)' };
  }
  if (Number(buf.readBigUInt64BE(8)) !== expectedIndex) {
    return { code: CODES.CORRUPT, ...at, detail: 'commit record page index mismatch' };
  }
  if (!buf.subarray(16, 48).equals(expectedHash)) {
    return { code: CODES.CORRUPT, ...at, detail: 'commit record hash mismatch (page tampered)' };
  }
  return null;
}
