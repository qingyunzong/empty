'use strict';

const { crc32 } = require('./crc32');
const { LogError } = require('./errors');

const BLOCK_MAGIC = 0x314b4c42; // "BLK1" little-endian
const INDEX_MAGIC = 0x31584449; // "IDX1" little-endian

const TYPE_CODE = { event: 0, correction: 1, tombstone: 2 };
const TYPE_NAME = ['event', 'correction', 'tombstone'];

// ---- varint (LEB128, unsigned, Number-safe up to 2^53) ----

function encodeVarint(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LogError('E_FORMAT', `varint value out of range: ${value}`);
  }
  const bytes = [];
  let n = value;
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    bytes.push(b);
  } while (n > 0);
  return Buffer.from(bytes);
}

function decodeVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (offset >= buf.length) throw new LogError('E_FORMAT', 'truncated varint');
    const b = buf[offset++];
    result += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 56) throw new LogError('E_FORMAT', 'varint too long');
  }
  return [result, offset];
}

// zigzag maps signed ints to unsigned: 0,-1,1,-2,2 -> 0,1,2,3,4
function zigzag(n) {
  return n >= 0 ? n * 2 : -n * 2 - 1;
}

function unzigzag(z) {
  return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
}

function encodeString(s) {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([encodeVarint(b.length), b]);
}

function decodeString(buf, offset) {
  const [len, start] = decodeVarint(buf, offset);
  if (start + len > buf.length) throw new LogError('E_FORMAT', 'truncated string');
  return [buf.subarray(start, start + len).toString('utf8'), start + len];
}

function encodeBytes(b) {
  return Buffer.concat([encodeVarint(b.length), b]);
}

function decodeBytes(buf, offset) {
  const [len, start] = decodeVarint(buf, offset);
  if (start + len > buf.length) throw new LogError('E_FORMAT', 'truncated bytes');
  return [Buffer.from(buf.subarray(start, start + len)), start + len];
}

// ---- records (delta-encoded against the previous record in the block) ----
//
// event:      type, seqDelta, tsDelta, statusDelta, device, payload
// correction: type, seqDelta, tsDelta, statusDelta, payload, refGap, reason
// tombstone:  type, seqDelta, tsDelta, refGap, reason

function encodeRecord(rec, prev) {
  const parts = [Buffer.from([TYPE_CODE[rec.type]])];
  parts.push(encodeVarint(rec.seq - prev.seq));
  parts.push(encodeVarint(zigzag(rec.ts - prev.ts)));
  if (rec.type !== 'tombstone') {
    parts.push(encodeVarint(zigzag(rec.status - prev.status)));
  }
  if (rec.type === 'event') {
    parts.push(encodeString(rec.device));
  }
  if (rec.type !== 'tombstone') {
    parts.push(encodeBytes(rec.payload));
  }
  if (rec.type !== 'event') {
    parts.push(encodeVarint(rec.seq - rec.refSeq));
    parts.push(encodeString(rec.reason));
  }
  prev.seq = rec.seq;
  prev.ts = rec.ts;
  if (rec.type !== 'tombstone') prev.status = rec.status;
  return Buffer.concat(parts);
}

function decodeRecord(buf, offset, prev) {
  if (offset >= buf.length) throw new LogError('E_FORMAT', 'truncated record');
  const type = TYPE_NAME[buf[offset++]];
  if (!type) throw new LogError('E_FORMAT', `unknown record type ${buf[offset - 1]}`);
  let v;
  [v, offset] = decodeVarint(buf, offset);
  const seq = prev.seq + v;
  [v, offset] = decodeVarint(buf, offset);
  const ts = prev.ts + unzigzag(v);
  let status = prev.status;
  let device;
  let payload = Buffer.alloc(0);
  let refSeq;
  let reason;
  if (type !== 'tombstone') {
    [v, offset] = decodeVarint(buf, offset);
    status = prev.status + unzigzag(v);
  }
  if (type === 'event') {
    [device, offset] = decodeString(buf, offset);
  }
  if (type !== 'tombstone') {
    [payload, offset] = decodeBytes(buf, offset);
  }
  if (type !== 'event') {
    [v, offset] = decodeVarint(buf, offset);
    refSeq = seq - v;
    [reason, offset] = decodeString(buf, offset);
  }
  prev.seq = seq;
  prev.ts = ts;
  prev.status = status;
  const rec = { type, seq, ts };
  if (type === 'event') Object.assign(rec, { device, status, payload });
  if (type === 'correction') Object.assign(rec, { status, payload, refSeq, reason });
  if (type === 'tombstone') Object.assign(rec, { refSeq, reason });
  return [rec, offset];
}

// ---- blocks ----
// u32 magic | u32 payloadLen | u32 recordCount | payload | u32 crc32(magic..payload)

const BLOCK_HEADER_LEN = 12;

function encodeBlock(records) {
  const prev = { seq: 0, ts: 0, status: 0 };
  const parts = records.map((r) => encodeRecord(r, prev));
  const payload = Buffer.concat(parts);
  const header = Buffer.alloc(BLOCK_HEADER_LEN);
  header.writeUInt32LE(BLOCK_MAGIC, 0);
  header.writeUInt32LE(payload.length, 4);
  header.writeUInt32LE(records.length, 8);
  const body = Buffer.concat([header, payload]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32LE(crc32(body), 0);
  return Buffer.concat([body, crcBuf]);
}

function decodeBlock(buf, offset) {
  if (offset + BLOCK_HEADER_LEN > buf.length) {
    throw new LogError('E_FORMAT', 'truncated block header');
  }
  if (buf.readUInt32LE(offset) !== BLOCK_MAGIC) {
    throw new LogError('E_FORMAT', `bad block magic at offset ${offset}`);
  }
  const payloadLen = buf.readUInt32LE(offset + 4);
  const count = buf.readUInt32LE(offset + 8);
  const payloadEnd = offset + BLOCK_HEADER_LEN + payloadLen;
  if (payloadEnd + 4 > buf.length) {
    throw new LogError('E_FORMAT', 'truncated block payload');
  }
  const expected = buf.readUInt32LE(payloadEnd);
  const actual = crc32(buf.subarray(offset, payloadEnd));
  if (expected !== actual) {
    throw new LogError('E_CRC', `block crc mismatch at offset ${offset}`);
  }
  const payload = buf.subarray(offset + BLOCK_HEADER_LEN, payloadEnd);
  const prev = { seq: 0, ts: 0, status: 0 };
  const records = [];
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    let rec;
    [rec, cursor] = decodeRecord(payload, cursor, prev);
    records.push(rec);
  }
  if (cursor !== payload.length) {
    throw new LogError('E_FORMAT', 'block payload has trailing bytes');
  }
  return { records, nextOffset: payloadEnd + 4 };
}

// ---- tail index ----
// u32 magic | u32 count | count * (u32 seq, u64 offset) | u32 crc32(all preceding)

const INDEX_ENTRY_LEN = 12;

function encodeIndex(entries) {
  const body = Buffer.alloc(8 + entries.length * INDEX_ENTRY_LEN);
  body.writeUInt32LE(INDEX_MAGIC, 0);
  body.writeUInt32LE(entries.length, 4);
  entries.forEach((e, i) => {
    body.writeUInt32LE(e.seq, 8 + i * INDEX_ENTRY_LEN);
    body.writeBigUInt64LE(BigInt(e.offset), 8 + i * INDEX_ENTRY_LEN + 4);
  });
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32LE(crc32(body), 0);
  return Buffer.concat([body, crcBuf]);
}

function decodeIndex(buf, offset) {
  if (offset + 8 > buf.length) throw new LogError('E_INDEX', 'index out of bounds');
  if (buf.readUInt32LE(offset) !== INDEX_MAGIC) {
    throw new LogError('E_INDEX', 'bad index magic');
  }
  const count = buf.readUInt32LE(offset + 4);
  const entriesEnd = offset + 8 + count * INDEX_ENTRY_LEN;
  if (entriesEnd + 4 > buf.length) throw new LogError('E_INDEX', 'truncated index');
  const expected = buf.readUInt32LE(entriesEnd);
  const actual = crc32(buf.subarray(offset, entriesEnd));
  if (expected !== actual) throw new LogError('E_INDEX', 'index crc mismatch');
  const entries = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      seq: buf.readUInt32LE(offset + 8 + i * INDEX_ENTRY_LEN),
      offset: Number(buf.readBigUInt64LE(offset + 8 + i * INDEX_ENTRY_LEN + 4)),
    });
  }
  return entries;
}

module.exports = {
  BLOCK_MAGIC,
  INDEX_MAGIC,
  BLOCK_HEADER_LEN,
  encodeVarint,
  decodeVarint,
  zigzag,
  unzigzag,
  encodeRecord,
  decodeRecord,
  encodeBlock,
  decodeBlock,
  encodeIndex,
  decodeIndex,
};
