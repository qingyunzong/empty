'use strict';

const { createHash } = require('node:crypto');
const { crc32 } = require('./crc32');
const { CorruptError } = require('./errors');

const MAGIC = Buffer.from('SLYR', 'ascii');
const VERSION = 1;

const KIND = Object.freeze({
  reserve: 1,
  freeze: 2,
  pay: 3,
  revert: 4,
  checkpoint: 5,
});
const KIND_NAME = Object.freeze(Object.fromEntries(
  Object.entries(KIND).map(([name, code]) => [code, name]),
));

// header: magic(4) version(1) kind(1) seq(8) parentHash(32) txSetHash(32) payloadLen(4)
const HEADER_LEN = 4 + 1 + 1 + 8 + 32 + 32 + 4;
const CRC_LEN = 4;
const ZERO_HASH = Buffer.alloc(32);

function sha256(buf) {
  return createHash('sha256').update(buf).digest();
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function txSetHashOf(txs) {
  return sha256(Buffer.from(stableStringify(txs), 'utf8'));
}

// payload: { txs: [...] } for delta layers, { state: {...} } for checkpoints
function encodeChunk({ kind, seq, parentHash, payload }) {
  const kindCode = typeof kind === 'string' ? KIND[kind] : kind;
  if (!kindCode) throw new Error(`unknown chunk kind: ${kind}`);
  const payloadBuf = Buffer.from(JSON.stringify(payload), 'utf8');
  const parent = parentHash == null
    ? ZERO_HASH
    : Buffer.isBuffer(parentHash) ? parentHash : Buffer.from(parentHash, 'hex');
  if (parent.length !== 32) throw new Error('parentHash must be 32 bytes');

  const txSetHash = payload.txs ? txSetHashOf(payload.txs) : sha256(payloadBuf);
  const header = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(header, 0);
  header.writeUInt8(VERSION, 4);
  header.writeUInt8(kindCode, 5);
  header.writeBigUInt64LE(BigInt(seq), 6);
  parent.copy(header, 14);
  txSetHash.copy(header, 46);
  header.writeUInt32LE(payloadBuf.length, 78);

  const body = Buffer.concat([header, payloadBuf]);
  const crcBuf = Buffer.alloc(CRC_LEN);
  crcBuf.writeUInt32LE(crc32(body), 0);
  return Buffer.concat([body, crcBuf]);
}

// Decodes one chunk starting at buf[offset].
// Structural problems (bad magic/version, truncated) throw CorruptError.
// A CRC mismatch does NOT throw; the returned chunk has crcOk=false so that
// callers can still use the length fields to continue scanning.
function decodeChunk(buf, offset = 0) {
  if (offset + HEADER_LEN + CRC_LEN > buf.length) {
    throw new CorruptError(`truncated chunk at offset ${offset}`);
  }
  if (!buf.subarray(offset, offset + 4).equals(MAGIC)) {
    throw new CorruptError(`bad magic at offset ${offset}`);
  }
  const version = buf.readUInt8(offset + 4);
  if (version !== VERSION) {
    throw new CorruptError(`unsupported version ${version} at offset ${offset}`);
  }
  const kindCode = buf.readUInt8(offset + 5);
  if (!KIND_NAME[kindCode]) {
    throw new CorruptError(`unknown kind ${kindCode} at offset ${offset}`);
  }
  const seq = Number(buf.readBigUInt64LE(offset + 6));
  const parentHash = Buffer.from(buf.subarray(offset + 14, offset + 46));
  const txSetHash = Buffer.from(buf.subarray(offset + 46, offset + 78));
  const payloadLen = buf.readUInt32LE(offset + 78);
  const end = offset + HEADER_LEN + payloadLen + CRC_LEN;
  if (end > buf.length) {
    throw new CorruptError(`truncated payload at offset ${offset}`);
  }
  const body = buf.subarray(offset, offset + HEADER_LEN + payloadLen);
  const expectedCrc = buf.readUInt32LE(offset + HEADER_LEN + payloadLen);
  const crcOk = crc32(body) === expectedCrc;
  const raw = Buffer.from(buf.subarray(offset, end));

  let payload = null;
  if (crcOk) {
    payload = JSON.parse(Buffer.from(buf.subarray(offset + HEADER_LEN, offset + HEADER_LEN + payloadLen)).toString('utf8'));
  }
  return {
    chunk: {
      kind: KIND_NAME[kindCode],
      kindCode,
      seq,
      parentHash: parentHash.toString('hex'),
      txSetHash: txSetHash.toString('hex'),
      payload,
      crcOk,
      hash: sha256(raw).toString('hex'),
      length: raw.length,
    },
    bytesRead: raw.length,
  };
}

function chunkHash(encoded) {
  return sha256(encoded).toString('hex');
}

module.exports = {
  MAGIC,
  VERSION,
  KIND,
  KIND_NAME,
  HEADER_LEN,
  ZERO_HASH_HEX: ZERO_HASH.toString('hex'),
  encodeChunk,
  decodeChunk,
  chunkHash,
  txSetHashOf,
  stableStringify,
};
