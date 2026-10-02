import { createHash } from 'node:crypto';
import { crc32 } from './crc32.js';
import { CorruptError } from './errors.js';

export const MAGIC = Buffer.from('LGR1');
export const TYPE_SNAPSHOT = 1;
export const TYPE_DELTA = 2;
// magic(4) version(4) type(1) offset(4) payloadLen(4) crc32(4) prevHash(32)
export const HEADER_LEN = 53;
export const ZERO_HASH = Buffer.alloc(32);

export function sha256(data) {
  return createHash('sha256').update(data).digest();
}

export function encodeBlock({ version, type, offset, payload, prevHash }) {
  const header = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(header, 0);
  header.writeUInt32LE(version, 4);
  header.writeUInt8(type, 8);
  header.writeUInt32LE(offset, 9);
  header.writeUInt32LE(payload.length, 13);
  header.writeUInt32LE(crc32(payload), 17);
  prevHash.copy(header, 21);
  return Buffer.concat([header, payload]);
}

export function blockHash(blockBuf) {
  return sha256(blockBuf);
}

// Decodes and fully validates the block at `offset` in `buf`:
// magic, self-offset, type, chain link, bounds and payload CRC32.
// Throws CorruptError on any inconsistency.
export function decodeBlock(buf, offset, expectedPrevHash) {
  if (offset + HEADER_LEN > buf.length) {
    throw new CorruptError(`truncated header at offset ${offset}`);
  }
  if (!buf.subarray(offset, offset + 4).equals(MAGIC)) {
    throw new CorruptError(`bad magic at offset ${offset}`);
  }
  const version = buf.readUInt32LE(offset + 4);
  const type = buf.readUInt8(offset + 8);
  const selfOffset = buf.readUInt32LE(offset + 9);
  const payloadLen = buf.readUInt32LE(offset + 13);
  const crc = buf.readUInt32LE(offset + 17);
  const prevHash = buf.subarray(offset + 21, offset + HEADER_LEN);
  if (selfOffset !== offset) {
    throw new CorruptError(`offset mismatch at ${offset}: header says ${selfOffset}`);
  }
  if (type !== TYPE_SNAPSHOT && type !== TYPE_DELTA) {
    throw new CorruptError(`unknown block type ${type} at offset ${offset}`);
  }
  if (!prevHash.equals(expectedPrevHash)) {
    throw new CorruptError(`chain broken at offset ${offset}`);
  }
  const end = offset + HEADER_LEN + payloadLen;
  if (end > buf.length) {
    throw new CorruptError(`truncated payload at offset ${offset}`);
  }
  const payload = buf.subarray(offset + HEADER_LEN, end);
  if (crc32(payload) !== crc) {
    throw new CorruptError(`CRC32 mismatch at offset ${offset} (version ${version})`);
  }
  return {
    version,
    type,
    offset,
    payload,
    length: HEADER_LEN + payloadLen,
    hash: blockHash(buf.subarray(offset, end)),
  };
}

// Reads only the version field of the block header at `offset` without
// validating anything. Callers must ensure a full header is present.
export function peekVersion(buf, offset) {
  if (offset + HEADER_LEN > buf.length) {
    throw new CorruptError(`truncated header at offset ${offset}`);
  }
  return buf.readUInt32LE(offset + 4);
}
