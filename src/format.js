'use strict';

const crypto = require('node:crypto');
const { crc32c } = require('./crc32c');

// File layout:
//   MAGIC (8 bytes) then a sequence of block records.
// Block record layout (all integers little-endian):
//   header (64 bytes):
//     0   u8    type        1=DATA 2=CORRECT 3=UNDO
//     1   u8    version     currently 1
//     2   u64   id          sequential block id, starts at 0
//     10  u64   targetId    CORRECT: replaced block id; UNDO: correction id; else NONE
//     18  i64   timestamp   observation time, ms since epoch
//     26  u32   payloadLen
//     30  32B   prevHash    sha256 of the previous block's 64-byte header; genesis = zeros.
//                         The chain covers block structure (id/type/target/ts/length and the
//                         previous link); payload content is protected by the per-block CRC32C,
//                         so a CRC-damaged block can be skipped without breaking the chain.
//     62  2B    reserved (0)
//   payload (payloadLen bytes)
//   crc32c (4 bytes) over header+payload
//   index footnote (60 bytes):
//     0   4B    "IDX1"
//     4   u64   id
//     12  u64   offset      file offset of this block record
//     20  u64   totalLen    header+payload+crc+footnote
//     28  u8    type
//     29  7B    reserved (0)
//     36  u64   targetId
//     44  i64   timestamp
//     52  u32   payloadLen
//     56  u32   crc32c over footnote[0..56)

const MAGIC = Buffer.from('WXBLK001', 'ascii');
const VERSION = 1;
const HEADER_LEN = 64;
const CRC_LEN = 4;
const FOOT_LEN = 60;
const FOOT_MAGIC = Buffer.from('IDX1', 'ascii');
const MIN_BLOCK_LEN = HEADER_LEN + CRC_LEN + FOOT_LEN;
const HASH_LEN = 32;
const ZERO_HASH = Buffer.alloc(HASH_LEN);

const TYPE = { DATA: 1, CORRECT: 2, UNDO: 3 };
const TYPE_NAME = { 1: 'DATA', 2: 'CORRECT', 3: 'UNDO' };
const NONE_U64 = 0xffffffffffffffffn; // on-disk "no target"
const NONE = -1;                      // in-memory "no target"

function toU64(n) {
  return n === NONE || n === undefined || n === null ? NONE_U64 : BigInt(n);
}
function fromU64(v) {
  return v === NONE_U64 ? NONE : Number(v);
}

function blockHash(header) {
  return crypto.createHash('sha256').update(header).digest();
}

function encodeBlock({ type, id, targetId = NONE, timestamp, payload, prevHash, offset }) {
  const header = Buffer.alloc(HEADER_LEN);
  header.writeUInt8(type, 0);
  header.writeUInt8(VERSION, 1);
  header.writeBigUInt64LE(BigInt(id), 2);
  header.writeBigUInt64LE(toU64(targetId), 10);
  header.writeBigInt64LE(BigInt(timestamp), 18);
  header.writeUInt32LE(payload.length, 26);
  Buffer.from(prevHash).copy(header, 30);

  const crc = Buffer.alloc(CRC_LEN);
  crc.writeUInt32LE(crc32c(Buffer.concat([header, payload])), 0);

  const totalLen = HEADER_LEN + payload.length + CRC_LEN + FOOT_LEN;
  const foot = Buffer.alloc(FOOT_LEN);
  FOOT_MAGIC.copy(foot, 0);
  foot.writeBigUInt64LE(BigInt(id), 4);
  foot.writeBigUInt64LE(BigInt(offset), 12);
  foot.writeBigUInt64LE(BigInt(totalLen), 20);
  foot.writeUInt8(type, 28);
  foot.writeBigUInt64LE(toU64(targetId), 36);
  foot.writeBigInt64LE(BigInt(timestamp), 44);
  foot.writeUInt32LE(payload.length, 52);
  foot.writeUInt32LE(crc32c(foot.subarray(0, 56)), 56);

  return Buffer.concat([header, payload, crc, foot]);
}

// Attempt to parse one block record at `offset` inside `buf`.
// Returns { status: 'ok', block } | { status: 'truncated' } | { status: 'garbage' }.
function tryParseBlock(buf, offset) {
  if (offset + HEADER_LEN > buf.length) return { status: 'truncated' };
  const header = buf.subarray(offset, offset + HEADER_LEN);
  const type = header.readUInt8(0);
  const payloadLen = header.readUInt32LE(26);
  const totalLen = HEADER_LEN + payloadLen + CRC_LEN + FOOT_LEN;
  if (offset + totalLen > buf.length) return { status: 'truncated' };
  if (type !== TYPE.DATA && type !== TYPE.CORRECT && type !== TYPE.UNDO) return { status: 'garbage' };
  const footOff = offset + HEADER_LEN + payloadLen + CRC_LEN;
  if (!buf.subarray(footOff, footOff + 4).equals(FOOT_MAGIC)) return { status: 'garbage' };

  const raw = buf.subarray(offset, offset + totalLen);
  const payload = buf.subarray(offset + HEADER_LEN, offset + HEADER_LEN + payloadLen);
  const crcStored = buf.readUInt32LE(offset + HEADER_LEN + payloadLen);
  const crcActual = crc32c(buf.subarray(offset, offset + HEADER_LEN + payloadLen));

  const foot = buf.subarray(footOff, footOff + FOOT_LEN);
  const footCrcStored = foot.readUInt32LE(56);
  const footCrcActual = crc32c(foot.subarray(0, 56));

  const block = {
    type,
    version: header.readUInt8(1),
    id: Number(header.readBigUInt64LE(2)),
    targetId: fromU64(header.readBigUInt64LE(10)),
    timestamp: Number(header.readBigInt64LE(18)),
    payloadLen,
    offset,
    totalLen,
    prevHash: Buffer.from(header.subarray(30, 62)),
    payload: Buffer.from(payload),
    crcStored,
    crcActual,
    crcOk: crcStored === crcActual,
    foot: {
      id: Number(foot.readBigUInt64LE(4)),
      offset: Number(foot.readBigUInt64LE(12)),
      totalLen: Number(foot.readBigUInt64LE(20)),
      type: foot.readUInt8(28),
      targetId: fromU64(foot.readBigUInt64LE(36)),
      timestamp: Number(foot.readBigInt64LE(44)),
      payloadLen: foot.readUInt32LE(52),
    },
    footCrcOk: footCrcStored === footCrcActual,
    raw: Buffer.from(raw),
    hash: blockHash(header),
  };
  return { status: 'ok', block };
}

module.exports = {
  MAGIC, VERSION, HEADER_LEN, CRC_LEN, FOOT_LEN, MIN_BLOCK_LEN, HASH_LEN, ZERO_HASH,
  TYPE, TYPE_NAME, NONE, encodeBlock, tryParseBlock, blockHash,
};
