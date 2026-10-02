// Binary layout of the log file.
//
// File:    HEADER(4) BLOCK* INDEX
// Block:   'E' 'B' u8version varint(recordCount) u32le(payloadLen) payload u32le(crc32)
//          crc32 covers everything from the magic through the end of payload.
// Record:  u8 type | svarint seqDelta | svarint tsDelta | <type specific>
//          seq/ts deltas are relative to the previous record inside the block
//          (first record of a block is absolute, delta from zero).
// Index:   payload u32le(crc32 of payload) u32le(payloadLen) 'EIDX'
//          payload = varint(count) { varint(seq) varint(blockOffset) u8(type) }*
import { crc32 } from './crc32.js';
import { LogError, E_CRC, E_FORMAT, E_TRUNCATED } from './errors.js';

export const RECORD_TYPE = Object.freeze({ EVENT: 1, CORRECTION: 2, TOMBSTONE: 3 });
export const RECORD_TYPE_NAME = Object.freeze({ 1: 'event', 2: 'correction', 3: 'tombstone' });
export const HEADER = Buffer.from('EVL1');
export const BLOCK_VERSION = 1;
const BLOCK_MAGIC_0 = 0x45; // 'E'
const BLOCK_MAGIC_1 = 0x42; // 'B'
const INDEX_MAGIC = Buffer.from('EIDX');
const BLOCK_HEADER_MIN = 2 + 1 + 1 + 4; // magic + version + count(varint>=1) + payloadLen
const BLOCK_TRAILER = 4; // crc32

const FIELD_DEVICE = 1;
const FIELD_STATUS = 2;
const FIELD_PAYLOAD = 4;

export class ByteWriter {
  constructor() {
    this.parts = [];
  }
  u8(n) {
    this.parts.push(Buffer.from([n & 0xff]));
  }
  u32le(n) {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32LE(n >>> 0, 0);
    this.parts.push(b);
  }
  varint(n) {
    const out = [];
    do {
      let byte = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) byte |= 0x80;
      out.push(byte);
    } while (n > 0);
    this.parts.push(Buffer.from(out));
  }
  svarint(n) {
    this.varint(n >= 0 ? n * 2 : -2 * n - 1);
  }
  bytes(buf) {
    this.varint(buf.length);
    this.parts.push(buf);
  }
  str(s) {
    this.bytes(Buffer.from(s, 'utf8'));
  }
  buffer() {
    return Buffer.concat(this.parts);
  }
}

export class ByteReader {
  constructor(buf, offset = 0, end = buf.length) {
    this.buf = buf;
    this.pos = offset;
    this.end = end;
  }
  need(n) {
    if (this.pos + n > this.end) {
      throw new LogError(E_TRUNCATED, 'unexpected end of data');
    }
  }
  u8() {
    this.need(1);
    return this.buf[this.pos++];
  }
  u32le() {
    this.need(4);
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  varint() {
    let result = 0;
    let shift = 1;
    for (;;) {
      const byte = this.u8();
      result += (byte & 0x7f) * shift;
      if ((byte & 0x80) === 0) return result;
      shift *= 128;
      if (shift > 2 ** 53) throw new LogError(E_FORMAT, 'varint too long');
    }
  }
  svarint() {
    const v = this.varint();
    return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
  }
  bytes() {
    const len = this.varint();
    this.need(len);
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  str() {
    return this.bytes().toString('utf8');
  }
}

function encodeRecordBody(rec, prev) {
  const w = new ByteWriter();
  w.u8(rec.type);
  w.svarint(rec.seq - prev.seq);
  w.svarint(rec.ts - prev.ts);
  if (rec.type === RECORD_TYPE.EVENT) {
    w.str(rec.device);
    w.varint(rec.status);
    w.bytes(rec.payload);
  } else if (rec.type === RECORD_TYPE.CORRECTION) {
    w.varint(rec.refSeq);
    w.str(rec.reason);
    let mask = 0;
    if (rec.device !== undefined) mask |= FIELD_DEVICE;
    if (rec.status !== undefined) mask |= FIELD_STATUS;
    if (rec.payload !== undefined) mask |= FIELD_PAYLOAD;
    w.u8(mask);
    if (mask & FIELD_DEVICE) w.str(rec.device);
    if (mask & FIELD_STATUS) w.varint(rec.status);
    if (mask & FIELD_PAYLOAD) w.bytes(rec.payload);
  } else if (rec.type === RECORD_TYPE.TOMBSTONE) {
    w.varint(rec.refSeq);
    w.str(rec.reason);
  } else {
    throw new LogError(E_FORMAT, `unknown record type ${rec.type}`);
  }
  return w.buffer();
}

export function encodeBlock(records) {
  const payloadParts = [];
  const prev = { seq: 0, ts: 0 };
  for (const rec of records) {
    payloadParts.push(encodeRecordBody(rec, prev));
    prev.seq = rec.seq;
    prev.ts = rec.ts;
  }
  const payload = Buffer.concat(payloadParts);
  const head = new ByteWriter();
  head.u8(BLOCK_MAGIC_0);
  head.u8(BLOCK_MAGIC_1);
  head.u8(BLOCK_VERSION);
  head.varint(records.length);
  head.u32le(payload.length);
  const body = Buffer.concat([head.buffer(), payload]);
  const trailer = Buffer.allocUnsafe(4);
  trailer.writeUInt32LE(crc32(body), 0);
  return Buffer.concat([body, trailer]);
}

function decodeRecordBody(r, prev) {
  const type = r.u8();
  const seq = prev.seq + r.svarint();
  const ts = prev.ts + r.svarint();
  const rec = { type, seq, ts };
  if (type === RECORD_TYPE.EVENT) {
    rec.device = r.str();
    rec.status = r.varint();
    rec.payload = r.bytes();
  } else if (type === RECORD_TYPE.CORRECTION) {
    rec.refSeq = r.varint();
    rec.reason = r.str();
    const mask = r.u8();
    if (mask & FIELD_DEVICE) rec.device = r.str();
    if (mask & FIELD_STATUS) rec.status = r.varint();
    if (mask & FIELD_PAYLOAD) rec.payload = r.bytes();
  } else if (type === RECORD_TYPE.TOMBSTONE) {
    rec.refSeq = r.varint();
    rec.reason = r.str();
  } else {
    throw new LogError(E_FORMAT, `unknown record type ${type}`);
  }
  return rec;
}

// Decodes the block starting at buf[offset].
// Returns { records, size } where each record carries `raw` (its exact encoded
// bytes, used for certificate hashes) and size is the total block length.
export function decodeBlock(buf, offset) {
  const r = new ByteReader(buf, offset);
  if (r.u8() !== BLOCK_MAGIC_0 || r.u8() !== BLOCK_MAGIC_1) {
    throw new LogError(E_FORMAT, `bad block magic at offset ${offset}`);
  }
  if (r.u8() !== BLOCK_VERSION) {
    throw new LogError(E_FORMAT, `unsupported block version at offset ${offset}`);
  }
  const count = r.varint();
  const payloadLen = r.u32le();
  r.need(payloadLen + BLOCK_TRAILER);
  const crcExpected = buf.readUInt32LE(r.pos + payloadLen);
  const crcActual = crc32(buf.subarray(offset, r.pos + payloadLen));
  if (crcActual !== crcExpected) {
    throw new LogError(E_CRC, `block CRC mismatch at offset ${offset}`);
  }
  const records = [];
  const prev = { seq: 0, ts: 0 };
  const payloadEnd = r.pos + payloadLen;
  for (let i = 0; i < count; i++) {
    const recStart = r.pos;
    const rec = decodeRecordBody(r, prev);
    rec.raw = Buffer.from(buf.subarray(recStart, r.pos));
    records.push(rec);
    prev.seq = rec.seq;
    prev.ts = rec.ts;
  }
  if (r.pos !== payloadEnd) {
    throw new LogError(E_CRC, `block payload length mismatch at offset ${offset}`);
  }
  r.pos += BLOCK_TRAILER;
  return { records, size: r.pos - offset };
}

export function encodeIndex(entries) {
  // entries: array of [seq, { offset, type }]
  const w = new ByteWriter();
  w.varint(entries.length);
  for (const [seq, entry] of entries) {
    w.varint(seq);
    w.varint(entry.offset);
    w.u8(entry.type);
  }
  const payload = w.buffer();
  const out = new ByteWriter();
  out.parts.push(payload);
  out.u32le(crc32(payload));
  out.u32le(payload.length);
  out.parts.push(INDEX_MAGIC);
  return out.buffer();
}

// Reads the tail index. Returns { entries: Map, indexStart } or null when the
// index is missing/corrupt and a full scan rebuild is required.
export function decodeIndex(buf) {
  if (buf.length < 12) return null;
  if (!buf.subarray(buf.length - 4).equals(INDEX_MAGIC)) return null;
  const payloadLen = buf.readUInt32LE(buf.length - 8);
  const indexStart = buf.length - 12 - payloadLen;
  if (indexStart < HEADER.length) return null;
  const payload = buf.subarray(indexStart, indexStart + payloadLen);
  if (crc32(payload) !== buf.readUInt32LE(buf.length - 12)) return null;
  try {
    const r = new ByteReader(payload);
    const count = r.varint();
    const entries = new Map();
    for (let i = 0; i < count; i++) {
      const seq = r.varint();
      const offset = r.varint();
      const type = r.u8();
      entries.set(seq, { offset, type });
    }
    if (r.pos !== payload.length) return null;
    return { entries, indexStart };
  } catch {
    return null;
  }
}
