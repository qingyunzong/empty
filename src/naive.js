import fs from 'node:fs';
import path from 'node:path';
import { sha256, GENESIS_HASH, HEADER_SIZE, TRAILER_SIZE, MAGIC } from './page.js';

// Deliberately naive replayer used as a cross-check oracle in tests:
// no index, no shared validation code — it re-derives everything from bytes.
export function naiveReplay(dir, { pageSize = 4096 } = {}) {
  const file = path.join(dir, 'data.log');
  const result = {
    pages: 0,
    records: 0,
    tenants: {},
    root: GENESIS_HASH.toString('hex'),
    corrupt: null,
  };
  if (!fs.existsSync(file)) return result;
  const buf = fs.readFileSync(file);
  let prev = Buffer.alloc(32, 0);
  let offset = 0;
  while (offset + pageSize <= buf.length) {
    const page = buf.subarray(offset, offset + pageSize);
    if (!page.subarray(0, 8).equals(MAGIC)) {
      result.corrupt = { offset, reason: 'BAD_MAGIC' };
      break;
    }
    const index = page.readUInt32LE(8);
    const count = page.readUInt32LE(12);
    const payloadLength = page.readUInt32LE(16);
    if (index !== result.pages || payloadLength > pageSize - HEADER_SIZE - TRAILER_SIZE) {
      result.corrupt = { offset, reason: 'BAD_HEADER' };
      break;
    }
    const payload = page.subarray(HEADER_SIZE, HEADER_SIZE + payloadLength);
    if (!sha256(payload).equals(page.subarray(52, 84))) {
      result.corrupt = { offset, reason: 'BAD_PAYLOAD_HASH' };
      break;
    }
    const pageHash = sha256(page.subarray(0, HEADER_SIZE), payload);
    if (!pageHash.equals(page.subarray(pageSize - TRAILER_SIZE))) {
      result.corrupt = { offset, reason: 'BAD_TRAILER' };
      break;
    }
    if (!page.subarray(20, 52).equals(prev)) {
      result.corrupt = { offset, reason: 'BAD_CHAIN' };
      break;
    }
    const lines = payload.toString('utf8').split('\n').filter((l) => l.length > 0);
    if (lines.length !== count) {
      result.corrupt = { offset, reason: 'BAD_RECORD' };
      break;
    }
    for (const line of lines) {
      const record = JSON.parse(line);
      const t = result.tenants[record.tenant] ?? { count: 0, bytes: 0, lastSeq: -1 };
      t.count += 1;
      t.bytes += Buffer.byteLength(line, 'utf8') + 1;
      t.lastSeq = record.seq;
      result.tenants[record.tenant] = t;
      result.records += 1;
    }
    prev = pageHash;
    result.root = pageHash.toString('hex');
    result.pages += 1;
    offset += pageSize;
  }
  if (!result.corrupt && offset < buf.length) {
    result.corrupt = { offset, reason: 'TRAILING_BYTES' };
  }
  return result;
}
