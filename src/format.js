'use strict';

const { crc32 } = require('./crc32');

const MAGIC = Buffer.from('PTP1', 'ascii');
const END_MAGIC = Buffer.from('PTPE', 'ascii');
const BLOCK_DICT = 1;
const BLOCK_RECORDS = 2;
const BLOCK_INDEX = 3;
const BLOCK_HEADER_LEN = 9; // u8 type + u32 payloadLen + u32 crc32
const FOOTER_LEN = 16; // u64 indexOffset + u32 indexCrc + 4B magic
const FIELD_IDS = { gtin: 0, batch: 1, station: 2 };
const FIELD_NAMES = ['gtin', 'batch', 'station'];

class FormatError extends Error {
  constructor(message) {
    super(message);
    this.code = 'E_FORMAT';
  }
}

class ByteWriter {
  constructor() {
    this.chunks = [];
    this.len = 0;
  }
  _push(b) {
    this.chunks.push(b);
    this.len += b.length;
  }
  u8(v) {
    const b = Buffer.allocUnsafe(1);
    b.writeUInt8(v, 0);
    this._push(b);
  }
  u16(v) {
    const b = Buffer.allocUnsafe(2);
    b.writeUInt16LE(v, 0);
    this._push(b);
  }
  u32(v) {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32LE(v >>> 0, 0);
    this._push(b);
  }
  u64(v) {
    const b = Buffer.allocUnsafe(8);
    b.writeBigUInt64LE(BigInt(v), 0);
    this._push(b);
  }
  i64(v) {
    const b = Buffer.allocUnsafe(8);
    b.writeBigInt64LE(BigInt(v), 0);
    this._push(b);
  }
  varint(v) {
    let x = BigInt(v);
    for (;;) {
      const byte = Number(x & 0x7fn);
      x >>= 7n;
      if (x === 0n) {
        this.u8(byte);
        return;
      }
      this.u8(byte | 0x80);
    }
  }
  zigzag(v) {
    const x = BigInt(v);
    this.varint((x << 1n) ^ (x >> 63n));
  }
  bytes(b) {
    this._push(b);
  }
  str(s) {
    const b = Buffer.from(s, 'utf8');
    this.u16(b.length);
    this._push(b);
  }
  concat() {
    return Buffer.concat(this.chunks, this.len);
  }
}

class ByteReader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  _need(n) {
    if (this.pos + n > this.buf.length) throw new FormatError('truncated payload');
  }
  u8() {
    this._need(1);
    return this.buf.readUInt8(this.pos++);
  }
  u16() {
    this._need(2);
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }
  u32() {
    this._need(4);
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  u64() {
    this._need(8);
    const v = this.buf.readBigUInt64LE(this.pos);
    this.pos += 8;
    return Number(v);
  }
  i64() {
    this._need(8);
    const v = this.buf.readBigInt64LE(this.pos);
    this.pos += 8;
    return Number(v);
  }
  varint() {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const b = this.u8();
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
      if (shift > 63n) throw new FormatError('varint too long');
    }
  }
  zigzag() {
    const x = this.varint();
    return Number((x >> 1n) ^ -(x & 1n));
  }
  bytes(n) {
    this._need(n);
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
  str() {
    const n = this.u16();
    return this.bytes(n).toString('utf8');
  }
  get done() {
    return this.pos === this.buf.length;
  }
}

// entries: [{field: 'gtin'|'batch'|'station', id, value}]
function encodeDictBlockPayload({ version, entries }) {
  const w = new ByteWriter();
  w.u32(version);
  w.u32(entries.length);
  const sorted = [...entries].sort(
    (a, b) => FIELD_IDS[a.field] - FIELD_IDS[b.field] || a.id - b.id
  );
  for (const e of sorted) {
    w.u8(FIELD_IDS[e.field]);
    w.u32(e.id);
    w.str(e.value);
  }
  return w.concat();
}

function decodeDictBlockPayload(buf) {
  const r = new ByteReader(buf);
  const version = r.u32();
  const count = r.u32();
  const entries = [];
  for (let i = 0; i < count; i++) {
    const fieldId = r.u8();
    if (fieldId >= FIELD_NAMES.length) throw new FormatError('unknown field id');
    const id = r.u32();
    const value = r.str();
    entries.push({ field: FIELD_NAMES[fieldId], id, value });
  }
  if (!r.done) throw new FormatError('trailing bytes in dict block');
  return { version, entries };
}

// records: [{gtinId, batchId, stationId, serial, timeMs}]
function encodeRecordBlockPayload({ dictVersion, baseTime, records }) {
  const w = new ByteWriter();
  w.u32(dictVersion);
  w.i64(baseTime);
  w.u32(records.length);
  for (const rec of records) {
    w.u32(rec.gtinId);
    w.u32(rec.batchId);
    w.u32(rec.stationId);
    w.zigzag(rec.timeMs - baseTime);
    w.str(rec.serial);
  }
  return w.concat();
}

function decodeRecordBlockPayload(buf) {
  const r = new ByteReader(buf);
  const dictVersion = r.u32();
  const baseTime = r.i64();
  const count = r.u32();
  const records = [];
  for (let i = 0; i < count; i++) {
    const gtinId = r.u32();
    const batchId = r.u32();
    const stationId = r.u32();
    const delta = r.zigzag();
    const serial = r.str();
    records.push({ gtinId, batchId, stationId, serial, timeMs: baseTime + delta });
  }
  if (!r.done) throw new FormatError('trailing bytes in record block');
  return { dictVersion, records };
}

function wrapBlock(type, payload) {
  const w = new ByteWriter();
  w.u8(type);
  w.u32(payload.length);
  w.u32(crc32(payload));
  w.bytes(payload);
  return w.concat();
}

// Returns {type, payloadLen, crc, totalLen} or null when fewer than 9 bytes remain.
function parseBlockHeader(buf, offset = 0) {
  if (buf.length - offset < BLOCK_HEADER_LEN) return null;
  const type = buf.readUInt8(offset);
  const payloadLen = buf.readUInt32LE(offset + 1);
  const crc = buf.readUInt32LE(offset + 5);
  return { type, payloadLen, crc, totalLen: BLOCK_HEADER_LEN + payloadLen };
}

// entries: [{offset, type, version, totalLen}]
function encodeIndex(entries) {
  const w = new ByteWriter();
  w.u32(entries.length);
  for (const e of entries) {
    w.u64(e.offset);
    w.u8(e.type);
    w.u32(e.version);
    w.u32(e.totalLen);
  }
  return w.concat();
}

function decodeIndex(buf) {
  const r = new ByteReader(buf);
  const count = r.u32();
  const entries = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      offset: r.u64(),
      type: r.u8(),
      version: r.u32(),
      totalLen: r.u32(),
    });
  }
  if (!r.done) throw new FormatError('trailing bytes in index');
  return entries;
}

function encodeFooter(indexOffset, indexCrc) {
  const w = new ByteWriter();
  w.u64(indexOffset);
  w.u32(indexCrc);
  w.bytes(END_MAGIC);
  return w.concat();
}

// buf must be the last FOOTER_LEN bytes of the file.
function parseFooter(buf) {
  if (buf.length < FOOTER_LEN) throw new FormatError('file too short for footer');
  const tail = buf.subarray(buf.length - FOOTER_LEN);
  if (!tail.subarray(12).equals(END_MAGIC)) throw new FormatError('bad end magic');
  return {
    indexOffset: Number(tail.readBigUInt64LE(0)),
    indexCrc: tail.readUInt32LE(8),
  };
}

// blocks: [{type, version, payload}] -> whole file buffer (header + blocks + index + footer)
function assembleFile(blocks) {
  const parts = [MAGIC];
  const index = [];
  let offset = MAGIC.length;
  for (const b of blocks) {
    const raw = wrapBlock(b.type, b.payload);
    index.push({ offset, type: b.type, version: b.version, totalLen: raw.length });
    parts.push(raw);
    offset += raw.length;
  }
  const indexPayload = encodeIndex(index);
  const indexBlock = wrapBlock(BLOCK_INDEX, indexPayload);
  parts.push(indexBlock);
  parts.push(encodeFooter(offset, crc32(indexPayload)));
  return Buffer.concat(parts);
}

module.exports = {
  MAGIC,
  END_MAGIC,
  BLOCK_DICT,
  BLOCK_RECORDS,
  BLOCK_INDEX,
  BLOCK_HEADER_LEN,
  FOOTER_LEN,
  FIELD_IDS,
  FIELD_NAMES,
  FormatError,
  encodeDictBlockPayload,
  decodeDictBlockPayload,
  encodeRecordBlockPayload,
  decodeRecordBlockPayload,
  wrapBlock,
  parseBlockHeader,
  encodeIndex,
  decodeIndex,
  encodeFooter,
  parseFooter,
  assembleFile,
};
