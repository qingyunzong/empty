import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { crc32 } from './crc32.js';
import { AuditError } from './errors.js';

export const MAGIC = Buffer.from('ABLK');
export const KIND = { ANCHOR: 1, DELTA: 2 };
export const KIND_NAME = { 1: 'anchor', 2: 'delta' };
// magic(4) kind(1) seqStart(8) seqEnd(8) prevHash(32) payloadLen(4)
export const HEADER_SIZE = 4 + 1 + 8 + 8 + 32 + 4;
export const CRC_SIZE = 4;
export const ZERO_HASH = Buffer.alloc(32);

export function encodeBlock({ kind, seqStart, seqEnd, prevHash, payload }) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header, 0);
  header.writeUInt8(kind, 4);
  header.writeBigUInt64BE(BigInt(seqStart), 5);
  header.writeBigUInt64BE(BigInt(seqEnd), 13);
  Buffer.from(prevHash).copy(header, 21);
  header.writeUInt32BE(body.length, 53);
  const crcBuf = Buffer.alloc(CRC_SIZE);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([header, body])), 0);
  const raw = Buffer.concat([header, body, crcBuf]);
  const hash = createHash('sha256').update(raw).digest();
  return { raw, hash };
}

export function readBlockAt(fd, offset, fileSize) {
  if (offset + HEADER_SIZE > fileSize) {
    throw new AuditError('BLOCK_TRUNCATED', `truncated block header at offset ${offset}`);
  }
  const header = Buffer.alloc(HEADER_SIZE);
  fs.readSync(fd, header, 0, HEADER_SIZE, offset);
  if (!header.subarray(0, 4).equals(MAGIC)) {
    throw new AuditError('BAD_MAGIC', `bad block magic at offset ${offset}`);
  }
  const kind = header.readUInt8(4);
  const seqStart = Number(header.readBigUInt64BE(5));
  const seqEnd = Number(header.readBigUInt64BE(13));
  const prevHash = Buffer.from(header.subarray(21, 53));
  const payloadLen = header.readUInt32BE(53);
  const range = [seqStart, seqEnd];
  const total = HEADER_SIZE + payloadLen + CRC_SIZE;
  if (offset + total > fileSize) {
    throw new AuditError('BLOCK_TRUNCATED', `truncated block seq ${seqStart}-${seqEnd} at offset ${offset}`, range);
  }
  const rest = Buffer.alloc(payloadLen + CRC_SIZE);
  fs.readSync(fd, rest, 0, rest.length, offset + HEADER_SIZE);
  const payloadBytes = rest.subarray(0, payloadLen);
  const crcStored = rest.readUInt32BE(payloadLen);
  const crcActual = crc32(Buffer.concat([header, payloadBytes]));
  if (crcActual !== crcStored) {
    throw new AuditError('CRC_MISMATCH', `crc mismatch in block seq ${seqStart}-${seqEnd} at offset ${offset}`, range);
  }
  let payload;
  try {
    payload = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    throw new AuditError('PAYLOAD_CORRUPT', `unparseable payload in block seq ${seqStart}-${seqEnd}`, range);
  }
  const hash = createHash('sha256').update(Buffer.concat([header, rest])).digest();
  return { kind, kindName: KIND_NAME[kind] ?? `unknown(${kind})`, seqStart, seqEnd, prevHash, payload, hash, length: total, offset };
}
