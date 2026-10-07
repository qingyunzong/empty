// Dictionary and record payload codecs.
//
// Dictionary payload (block type DICT):
//   u32le version | u32le entryCount
//   entry: u8 fieldTag | u16le byteLength | utf8 bytes
//   Entry id is the zero-based position inside the block.
//
// Record delta payload (block type RECORDS):
//   u32le dictVersion | i64le baseTimestampMs | u32le recordCount
//   record: u32le gtinId | u32le batchId | u32le workstationId
//           | i32le timestampDeltaMs | u16le serialByteLength | utf8 bytes
//
// High-frequency fields (gtin, batch, workstation) live in the dictionary;
// records reference them by id. Serial numbers are unique per label and are
// stored inline; timestamps are stored as a delta from the block base.

import { PackError, E_DICT, E_CRC } from './errors.js';

export const FIELD_TAG = Object.freeze({ gtin: 1, batch: 2, workstation: 3 });
export const TAG_FIELD = Object.freeze({ 1: 'gtin', 2: 'batch', 3: 'workstation' });

export function normalizeString(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PackError('E_ARG', `expected non-empty string, got ${JSON.stringify(value)}`);
  }
  return value.normalize('NFC');
}

export function normalizeTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return ms;
  }
  throw new PackError('E_ARG', `invalid timestamp ${JSON.stringify(value)}`);
}

export class Dictionary {
  constructor(version, entries) {
    this.version = version;
    this.entries = entries; // [{field, value}]
    this.byField = { gtin: new Map(), batch: new Map(), workstation: new Map() };
    entries.forEach((entry, id) => {
      this.byField[entry.field].set(entry.value, id);
    });
  }

  idOf(field, value) {
    return this.byField[field].get(value);
  }

  entryAt(id) {
    return id >= 0 && id < this.entries.length ? this.entries[id] : undefined;
  }
}

// values: { gtin: string[], batch: string[], workstation: string[] }
export function buildDictionary(version, values) {
  const entries = [];
  for (const field of ['gtin', 'batch', 'workstation']) {
    const seen = new Set();
    for (const raw of values[field] ?? []) {
      const value = normalizeString(raw);
      if (!seen.has(value)) {
        seen.add(value);
        entries.push({ field, value });
      }
    }
  }
  return new Dictionary(version, entries);
}

export function encodeDictionaryPayload(dict) {
  const parts = [];
  let size = 8;
  for (const entry of dict.entries) {
    const bytes = Buffer.byteLength(entry.value, 'utf8');
    if (bytes > 0xffff) throw new PackError('E_ARG', 'dictionary value too long');
    size += 3 + bytes;
  }
  const out = Buffer.alloc(size);
  out.writeUInt32LE(dict.version >>> 0, 0);
  out.writeUInt32LE(dict.entries.length, 4);
  let off = 8;
  for (const entry of dict.entries) {
    const bytes = Buffer.byteLength(entry.value, 'utf8');
    out.writeUInt8(FIELD_TAG[entry.field], off);
    out.writeUInt16LE(bytes, off + 1);
    out.write(entry.value, off + 3, bytes, 'utf8');
    off += 3 + bytes;
    parts.push(entry);
  }
  return out;
}

export function decodeDictionaryPayload(payload, expectedVersion) {
  try {
    if (payload.length < 8) throw new Error('short payload');
    const version = payload.readUInt32LE(0);
    if (expectedVersion !== undefined && version !== expectedVersion) {
      throw new Error(`version mismatch: header ${expectedVersion}, payload ${version}`);
    }
    const count = payload.readUInt32LE(4);
    const entries = [];
    let off = 8;
    for (let i = 0; i < count; i++) {
      if (off + 3 > payload.length) throw new Error('truncated entry');
      const tag = payload.readUInt8(off);
      const field = TAG_FIELD[tag];
      if (!field) throw new Error(`unknown field tag ${tag}`);
      const len = payload.readUInt16LE(off + 1);
      if (off + 3 + len > payload.length) throw new Error('truncated value');
      const value = payload.toString('utf8', off + 3, off + 3 + len);
      entries.push({ field, value });
      off += 3 + len;
    }
    if (off !== payload.length) throw new Error('trailing bytes');
    return new Dictionary(version, entries);
  } catch (err) {
    throw new PackError(E_DICT, `dictionary payload corrupt: ${err.message}`);
  }
}

// labels: [{ gtin, batch, workstation, serial, timestamp(ms) }] with
// gtin/batch/workstation already resolved against `dict`.
export function encodeRecordsPayload(dict, labels) {
  if (labels.length === 0) throw new PackError('E_ARG', 'empty record block');
  const base = labels.reduce((min, l) => Math.min(min, l.timestamp), labels[0].timestamp);
  const records = labels.map((label) => {
    const gtinId = dict.idOf('gtin', label.gtin);
    const batchId = dict.idOf('batch', label.batch);
    const workstationId = dict.idOf('workstation', label.workstation);
    for (const [field, id] of [['gtin', gtinId], ['batch', batchId], ['workstation', workstationId]]) {
      if (id === undefined) {
        throw new PackError('E_DICTREF', `value ${JSON.stringify(label[field])} not in dictionary v${dict.version} (${field})`);
      }
    }
    const serial = normalizeString(label.serial);
    const serialBytes = Buffer.byteLength(serial, 'utf8');
    if (serialBytes > 0xffff) throw new PackError('E_ARG', 'serial too long');
    const delta = label.timestamp - base;
    if (delta > 0x7fffffff || delta < -0x80000000) {
      throw new PackError('E_ARG', 'timestamp delta out of range');
    }
    return { gtinId, batchId, workstationId, serial, serialBytes, delta };
  });
  let size = 16;
  for (const r of records) size += 18 + r.serialBytes;
  const out = Buffer.alloc(size);
  out.writeUInt32LE(dict.version >>> 0, 0);
  out.writeBigInt64LE(BigInt(base), 4);
  out.writeUInt32LE(records.length, 12);
  let off = 16;
  for (const r of records) {
    out.writeUInt32LE(r.gtinId, off);
    out.writeUInt32LE(r.batchId, off + 4);
    out.writeUInt32LE(r.workstationId, off + 8);
    out.writeInt32LE(r.delta, off + 12);
    out.writeUInt16LE(r.serialBytes, off + 16);
    out.write(r.serial, off + 18, r.serialBytes, 'utf8');
    off += 18 + r.serialBytes;
  }
  return out;
}

// Decodes the raw record payload into reference form (dictionary ids, not yet
// resolved). Resolution against a Dictionary happens in the reader so that
// reference errors surface as E_DICTREF rather than payload corruption.
export function decodeRecordsPayload(payload, expectedVersion) {
  try {
    if (payload.length < 16) throw new Error('short payload');
    const dictVersion = payload.readUInt32LE(0);
    if (expectedVersion !== undefined && dictVersion !== expectedVersion) {
      throw new Error(`version mismatch: header ${expectedVersion}, payload ${dictVersion}`);
    }
    const base = Number(payload.readBigInt64LE(4));
    const count = payload.readUInt32LE(12);
    const refs = [];
    let off = 16;
    for (let i = 0; i < count; i++) {
      if (off + 18 > payload.length) throw new Error('truncated record');
      const gtinId = payload.readUInt32LE(off);
      const batchId = payload.readUInt32LE(off + 4);
      const workstationId = payload.readUInt32LE(off + 8);
      const delta = payload.readInt32LE(off + 12);
      const serialLen = payload.readUInt16LE(off + 16);
      if (off + 18 + serialLen > payload.length) throw new Error('truncated serial');
      const serial = payload.toString('utf8', off + 18, off + 18 + serialLen);
      refs.push({ gtinId, batchId, workstationId, serial, timestamp: base + delta });
      off += 18 + serialLen;
    }
    if (off !== payload.length) throw new Error('trailing bytes');
    return { dictVersion, refs };
  } catch (err) {
    throw new PackError(E_CRC, `record payload corrupt: ${err.message}`);
  }
}
