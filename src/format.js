// Binary container format for label packs.
//
// File layout:
//   file header : 'PLPK' u16le formatVersion u16le flags            (8 bytes)
//   blocks      : sequence of blocks (dict blocks and record blocks)
//   index       : 'IDX1' u32le count, count * entry, u32le crc32
//   trailer     : u64le indexOffset, 'PLPKEND1'                     (16 bytes)
//
// Block layout:
//   u8 type | u32le version | u32le payloadLength | payload | u32le crc32
//   crc32 covers the 9-byte block header plus the payload.
//   `version` is the dictionary version: a dict block carries its own
//   version, a record block carries the version it is bound to. Keeping it
//   in the header lets a decoder attribute a CRC-damaged block to a
//   dictionary version without trusting the payload.
//
// Index entry:
//   u64le offset | u32le length | u8 type | u32le version           (17 bytes)

import { crc32 } from 'node:zlib';
import { PackError, E_FORMAT } from './errors.js';

export const FILE_MAGIC = Buffer.from('PLPK', 'ascii');
export const INDEX_MAGIC = Buffer.from('IDX1', 'ascii');
export const TRAILER_MAGIC = Buffer.from('PLPKEND1', 'ascii');
export const FORMAT_VERSION = 1;

export const FILE_HEADER_SIZE = 8;
export const BLOCK_HEADER_SIZE = 9;
export const BLOCK_CRC_SIZE = 4;
export const TRAILER_SIZE = 16;
export const INDEX_ENTRY_SIZE = 17;

export const BLOCK_TYPE = Object.freeze({ DICT: 1, RECORDS: 2 });

export function encodeFileHeader() {
  const buf = Buffer.alloc(FILE_HEADER_SIZE);
  FILE_MAGIC.copy(buf, 0);
  buf.writeUInt16LE(FORMAT_VERSION, 4);
  buf.writeUInt16LE(0, 6);
  return buf;
}

export function checkFileHeader(buf) {
  if (buf.length < FILE_HEADER_SIZE || !buf.subarray(0, 4).equals(FILE_MAGIC)) {
    throw new PackError(E_FORMAT, 'bad file magic');
  }
  const version = buf.readUInt16LE(4);
  if (version !== FORMAT_VERSION) {
    throw new PackError(E_FORMAT, `unsupported format version ${version}`);
  }
}

export function encodeBlock(type, version, payload) {
  const out = Buffer.alloc(BLOCK_HEADER_SIZE + payload.length + BLOCK_CRC_SIZE);
  out.writeUInt8(type, 0);
  out.writeUInt32LE(version >>> 0, 1);
  out.writeUInt32LE(payload.length, 5);
  payload.copy(out, BLOCK_HEADER_SIZE);
  const crc = crc32(out.subarray(0, BLOCK_HEADER_SIZE + payload.length));
  out.writeUInt32LE(crc >>> 0, BLOCK_HEADER_SIZE + payload.length);
  return out;
}

// Verify a raw block buffer (header + payload + crc). Returns
// { type, version, payload } or throws PackError(E_FORMAT). CRC mismatch is
// reported by the caller via crcOk=false style handling; here we return the
// parsed header plus a crcOk flag so callers can map failures to E_DICT/E_CRC.
export function parseBlock(raw) {
  if (raw.length < BLOCK_HEADER_SIZE + BLOCK_CRC_SIZE) {
    throw new PackError(E_FORMAT, 'block too short');
  }
  const type = raw.readUInt8(0);
  const version = raw.readUInt32LE(1);
  const payloadLength = raw.readUInt32LE(5);
  if (raw.length !== BLOCK_HEADER_SIZE + payloadLength + BLOCK_CRC_SIZE) {
    throw new PackError(E_FORMAT, 'block length mismatch');
  }
  const expected = raw.readUInt32LE(BLOCK_HEADER_SIZE + payloadLength);
  const actual = crc32(raw.subarray(0, BLOCK_HEADER_SIZE + payloadLength)) >>> 0;
  const payload = raw.subarray(BLOCK_HEADER_SIZE, BLOCK_HEADER_SIZE + payloadLength);
  return { type, version, payload, crcOk: expected === actual };
}

export function encodeIndex(entries) {
  const body = Buffer.alloc(4 + 4 + entries.length * INDEX_ENTRY_SIZE);
  INDEX_MAGIC.copy(body, 0);
  body.writeUInt32LE(entries.length, 4);
  let off = 8;
  for (const e of entries) {
    body.writeBigUInt64LE(BigInt(e.offset), off);
    body.writeUInt32LE(e.length, off + 8);
    body.writeUInt8(e.type, off + 12);
    body.writeUInt32LE(e.version >>> 0, off + 13);
    off += INDEX_ENTRY_SIZE;
  }
  const crc = crc32(body) >>> 0;
  const out = Buffer.alloc(body.length + 4);
  body.copy(out, 0);
  out.writeUInt32LE(crc, body.length);
  return out;
}

export function parseIndex(buf) {
  if (buf.length < 12 || !buf.subarray(0, 4).equals(INDEX_MAGIC)) {
    throw new PackError(E_FORMAT, 'bad index magic');
  }
  const expected = buf.readUInt32LE(buf.length - 4);
  const actual = crc32(buf.subarray(0, buf.length - 4)) >>> 0;
  if (expected !== actual) {
    throw new PackError(E_FORMAT, 'index crc mismatch');
  }
  const count = buf.readUInt32LE(4);
  if (buf.length !== 8 + count * INDEX_ENTRY_SIZE + 4) {
    throw new PackError(E_FORMAT, 'index length mismatch');
  }
  const entries = [];
  let off = 8;
  for (let i = 0; i < count; i++) {
    entries.push({
      offset: Number(buf.readBigUInt64LE(off)),
      length: buf.readUInt32LE(off + 8),
      type: buf.readUInt8(off + 12),
      version: buf.readUInt32LE(off + 13),
    });
    off += INDEX_ENTRY_SIZE;
  }
  return entries;
}

export function encodeTrailer(indexOffset) {
  const out = Buffer.alloc(TRAILER_SIZE);
  out.writeBigUInt64LE(BigInt(indexOffset), 0);
  TRAILER_MAGIC.copy(out, 8);
  return out;
}

export function parseTrailer(buf) {
  if (buf.length !== TRAILER_SIZE || !buf.subarray(8, 16).equals(TRAILER_MAGIC)) {
    throw new PackError(E_FORMAT, 'bad trailer');
  }
  return { indexOffset: Number(buf.readBigUInt64LE(0)) };
}
