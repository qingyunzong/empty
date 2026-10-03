import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { LedgerError } from './errors.js';

export const BLOCK_MAGIC = Buffer.from('AUB1', 'ascii');
export const MANIFEST_MAGIC = Buffer.from('AUM1', 'ascii');
export const BLOCK_TYPE = Object.freeze({ ANCHOR: 1, DELTA: 2 });
export const HEADER_LENGTH = 68;
export const MANIFEST_ENTRY_LENGTH = 64;
const NO_OFFSET_UINT64 = 0xffffffffffffffffn;

export function hashBuffer(buf) {
  return createHash('sha256').update(buf).digest();
}

export function encodeBlock({ type, startSeq, endSeq, prevOffset, prevHash, payload }) {
  const payloadBuf = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(HEADER_LENGTH);
  BLOCK_MAGIC.copy(header, 0);
  header.writeUInt8(1, 4);
  header.writeUInt8(type, 5);
  header.writeBigUInt64BE(BigInt(startSeq), 8);
  header.writeBigUInt64BE(BigInt(endSeq), 16);
  header.writeBigUInt64BE(prevOffset == null ? NO_OFFSET_UINT64 : BigInt(prevOffset), 24);
  if (prevHash) Buffer.from(prevHash).copy(header, 32);
  header.writeUInt32BE(payloadBuf.length, 64);
  const body = Buffer.concat([header, payloadBuf]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([body, crc]);
}

export function parseHeader(header, offset) {
  if (header.length < HEADER_LENGTH || !header.subarray(0, 4).equals(BLOCK_MAGIC)) {
    throw new LedgerError('CORRUPT_BLOCK', `invalid block header at offset ${offset}`, null);
  }
  const prevOffsetRaw = header.readBigUInt64BE(24);
  return {
    type: header.readUInt8(5),
    startSeq: Number(header.readBigUInt64BE(8)),
    endSeq: Number(header.readBigUInt64BE(16)),
    prevOffset: prevOffsetRaw === NO_OFFSET_UINT64 ? null : Number(prevOffsetRaw),
    prevHash: Buffer.from(header.subarray(32, 64)),
    payloadLength: header.readUInt32BE(64),
  };
}

export function readHeaderAt(fd, offset) {
  const header = Buffer.alloc(HEADER_LENGTH);
  const n = fs.readSync(fd, header, 0, HEADER_LENGTH, offset);
  if (n < HEADER_LENGTH) {
    throw new LedgerError('CORRUPT_BLOCK', `truncated block header at offset ${offset}`, null);
  }
  return parseHeader(header, offset);
}

export function readBlockAt(fd, offset, expectedHash = null) {
  const headerBuf = Buffer.alloc(HEADER_LENGTH);
  const n = fs.readSync(fd, headerBuf, 0, HEADER_LENGTH, offset);
  if (n < HEADER_LENGTH) {
    throw new LedgerError('CORRUPT_BLOCK', `truncated block header at offset ${offset}`, null);
  }
  const header = parseHeader(headerBuf, offset);
  const range = [header.startSeq, header.endSeq];
  const rest = Buffer.alloc(header.payloadLength + 4);
  const m = fs.readSync(fd, rest, 0, rest.length, offset + HEADER_LENGTH);
  if (m < rest.length) {
    throw new LedgerError('CORRUPT_BLOCK', `truncated block payload at offset ${offset}`, range);
  }
  const payloadBuf = rest.subarray(0, header.payloadLength);
  const expectedCrc = rest.readUInt32BE(header.payloadLength);
  const actualCrc = crc32(Buffer.concat([headerBuf, payloadBuf])) >>> 0;
  if (actualCrc !== expectedCrc) {
    throw new LedgerError(
      'CRC_MISMATCH',
      `crc32 mismatch in block covering seq ${header.startSeq}-${header.endSeq}`,
      range,
    );
  }
  const raw = Buffer.concat([headerBuf, rest]);
  const hash = hashBuffer(raw);
  if (expectedHash && !hash.equals(expectedHash)) {
    throw new LedgerError(
      'HASH_CHAIN_BROKEN',
      `hash mismatch for block covering seq ${header.startSeq}-${header.endSeq}`,
      range,
    );
  }
  let payload;
  try {
    payload = JSON.parse(payloadBuf.toString('utf8'));
  } catch {
    throw new LedgerError('CORRUPT_BLOCK', `invalid payload json at offset ${offset}`, range);
  }
  return { ...header, payload, hash, offset, length: raw.length };
}

export function encodeManifest(entries) {
  const buf = Buffer.alloc(8 + entries.length * MANIFEST_ENTRY_LENGTH + 4);
  MANIFEST_MAGIC.copy(buf, 0);
  buf.writeUInt32BE(entries.length, 4);
  entries.forEach((entry, i) => {
    const base = 8 + i * MANIFEST_ENTRY_LENGTH;
    buf.writeBigUInt64BE(BigInt(entry.offset), base);
    buf.writeBigUInt64BE(BigInt(entry.length), base + 8);
    buf.writeBigUInt64BE(BigInt(entry.startSeq), base + 16);
    buf.writeBigUInt64BE(BigInt(entry.endSeq), base + 24);
    Buffer.from(entry.hash).copy(buf, base + 32);
  });
  buf.writeUInt32BE(crc32(buf.subarray(0, buf.length - 4)) >>> 0, buf.length - 4);
  return buf;
}

export function parseManifest(buf) {
  const fail = (msg) => {
    throw new LedgerError('MANIFEST_CORRUPT', msg, null);
  };
  if (buf.length < 12 || !buf.subarray(0, 4).equals(MANIFEST_MAGIC)) fail('bad manifest magic');
  const count = buf.readUInt32BE(4);
  if (count < 1) fail('manifest has no entries');
  if (buf.length !== 8 + count * MANIFEST_ENTRY_LENGTH + 4) fail('manifest length mismatch');
  const expectedCrc = buf.readUInt32BE(buf.length - 4);
  if ((crc32(buf.subarray(0, buf.length - 4)) >>> 0) !== expectedCrc) fail('manifest crc mismatch');
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const base = 8 + i * MANIFEST_ENTRY_LENGTH;
    entries.push({
      offset: Number(buf.readBigUInt64BE(base)),
      length: Number(buf.readBigUInt64BE(base + 8)),
      startSeq: Number(buf.readBigUInt64BE(base + 16)),
      endSeq: Number(buf.readBigUInt64BE(base + 24)),
      hash: Buffer.from(buf.subarray(base + 32, base + 64)),
    });
  }
  return { entries };
}
