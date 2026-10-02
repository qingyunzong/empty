import { createHash } from 'node:crypto';

export const MAGIC = Buffer.from('AUDPG001', 'ascii');
export const HEADER_SIZE = 96;
export const TRAILER_SIZE = 32;
export const DEFAULT_PAGE_SIZE = 4096;
export const GENESIS_HASH = Buffer.alloc(32, 0);

export function sha256(...parts) {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

export function maxPayloadSize(pageSize = DEFAULT_PAGE_SIZE) {
  return pageSize - HEADER_SIZE - TRAILER_SIZE;
}

// Page layout (all integers little-endian):
//   [0,8)    magic "AUDPG001"
//   [8,12)   pageIndex  uint32
//   [12,16)  recordCount uint32
//   [16,20)  payloadLength uint32
//   [20,52)  prevHash   (hash chain link: pageHash of previous page, genesis = 32 zero bytes)
//   [52,84)  payloadHash = sha256(payload)
//   [84,96)  reserved zeros
//   [96, 96+payloadLength) payload: JSONL records (utf8, '\n' terminated)
//   [pageSize-32, pageSize) trailer: pageHash = sha256(header[0,96) || payload)
export function encodePage({ pageIndex, records, prevHash, pageSize = DEFAULT_PAGE_SIZE }) {
  const payload = Buffer.from(
    records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''),
    'utf8',
  );
  if (payload.length > maxPayloadSize(pageSize)) {
    const err = new Error(`payload ${payload.length} exceeds page capacity ${maxPayloadSize(pageSize)}`);
    err.code = 'PAGE_OVERFLOW';
    throw err;
  }
  const page = Buffer.alloc(pageSize, 0);
  MAGIC.copy(page, 0);
  page.writeUInt32LE(pageIndex, 8);
  page.writeUInt32LE(records.length, 12);
  page.writeUInt32LE(payload.length, 16);
  prevHash.copy(page, 20);
  sha256(payload).copy(page, 52);
  payload.copy(page, HEADER_SIZE);
  const pageHash = sha256(page.subarray(0, HEADER_SIZE), payload);
  pageHash.copy(page, pageSize - TRAILER_SIZE);
  return { page, pageHash, payloadLength: payload.length };
}

export function validatePage(page, expectedIndex, expectedPrevHash) {
  if (page.length < HEADER_SIZE + TRAILER_SIZE) return { ok: false, reason: 'BAD_LENGTH' };
  if (!page.subarray(0, 8).equals(MAGIC)) return { ok: false, reason: 'BAD_MAGIC' };
  const pageIndex = page.readUInt32LE(8);
  if (pageIndex !== expectedIndex) return { ok: false, reason: 'BAD_INDEX' };
  const recordCount = page.readUInt32LE(12);
  const payloadLength = page.readUInt32LE(16);
  if (payloadLength > maxPayloadSize(page.length)) return { ok: false, reason: 'BAD_LENGTH' };
  const payload = page.subarray(HEADER_SIZE, HEADER_SIZE + payloadLength);
  if (!sha256(payload).equals(page.subarray(52, 84))) return { ok: false, reason: 'BAD_PAYLOAD_HASH' };
  const pageHash = sha256(page.subarray(0, HEADER_SIZE), payload);
  if (!pageHash.equals(page.subarray(page.length - TRAILER_SIZE))) return { ok: false, reason: 'BAD_TRAILER' };
  if (!page.subarray(20, 52).equals(expectedPrevHash)) return { ok: false, reason: 'BAD_CHAIN' };
  const text = payload.toString('utf8');
  const lines = text.length ? text.split('\n').slice(0, -1) : [];
  if (lines.length !== recordCount) return { ok: false, reason: 'BAD_RECORD' };
  const records = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      return { ok: false, reason: 'BAD_RECORD' };
    }
  }
  return { ok: true, pageIndex, recordCount, records, pageHash };
}
