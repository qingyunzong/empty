'use strict';

const crypto = require('node:crypto');
const { crc32 } = require('./crc32');
const { CorruptionError } = require('./errors');

// 块布局（小端）：
//   [0:4]   magic 'STLK'
//   [4]     版本 = 1
//   [5]     类型（0 genesis / 1 reserve / 2 freeze / 3 pay / 4 revert / 5 checkpoint）
//   [6:10]  层级 uint32
//   [10:42] 父层哈希 sha256（genesis 为全零）
//   [42:74] 事务集合哈希 sha256（排序后 tx id 列表的 JSON）
//   [74:82] 自身偏移 uint64
//   [82:86] 负载长度 uint32
//   [86:..] 负载（JSON）
//   [..:+4] CRC32（覆盖此前全部字节）
const MAGIC = Buffer.from('STLK');
const VERSION = 1;
const HEADER_LEN = 86;
const CRC_LEN = 4;
const ZERO_HASH = Buffer.alloc(32);
const TYPES = { genesis: 0, reserve: 1, freeze: 2, pay: 3, revert: 4, checkpoint: 5 };
const TYPE_NAMES = ['genesis', 'reserve', 'freeze', 'pay', 'revert', 'checkpoint'];

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

function txSetHash(txs) {
  const ids = txs.map((t) => t.id).sort();
  return sha256(Buffer.from(JSON.stringify(ids), 'utf8'));
}

function encodeBlock({ type, layer, parentHash, txHash, offset, payload }) {
  if (!(type in TYPES)) throw new Error(`unknown block type: ${type}`);
  const payloadBuf = Buffer.from(JSON.stringify(payload), 'utf8');
  const buf = Buffer.alloc(HEADER_LEN + payloadBuf.length + CRC_LEN);
  MAGIC.copy(buf, 0);
  buf.writeUInt8(VERSION, 4);
  buf.writeUInt8(TYPES[type], 5);
  buf.writeUInt32LE(layer >>> 0, 6);
  parentHash.copy(buf, 10);
  txHash.copy(buf, 42);
  buf.writeBigUInt64LE(BigInt(offset), 74);
  buf.writeUInt32LE(payloadBuf.length, 82);
  payloadBuf.copy(buf, HEADER_LEN);
  const crc = crc32(buf.subarray(0, HEADER_LEN + payloadBuf.length));
  buf.writeUInt32LE(crc, HEADER_LEN + payloadBuf.length);
  return buf;
}

function fail(message, { torn = false, offset = -1 } = {}) {
  const err = new CorruptionError(message);
  err.torn = torn;
  err.offset = offset;
  throw err;
}

// 从 buf 的 offset 处解码一个块；返回 { block, length }。
// 任何不一致都抛 CorruptionError；字节不足时 err.torn = true。
function decodeBlock(buf, offset = 0) {
  if (offset + HEADER_LEN + CRC_LEN > buf.length) {
    fail(`truncated block header at offset ${offset}`, { torn: true, offset });
  }
  if (!buf.subarray(offset, offset + 4).equals(MAGIC)) {
    fail(`bad magic at offset ${offset}`, { offset });
  }
  const version = buf.readUInt8(offset + 4);
  if (version !== VERSION) fail(`unsupported version ${version} at offset ${offset}`, { offset });
  const typeCode = buf.readUInt8(offset + 5);
  const type = TYPE_NAMES[typeCode];
  if (!type) fail(`unknown block type code ${typeCode} at offset ${offset}`, { offset });
  const layer = buf.readUInt32LE(offset + 6);
  const parentHash = Buffer.from(buf.subarray(offset + 10, offset + 42));
  const txHash = Buffer.from(buf.subarray(offset + 42, offset + 74));
  const selfOffset = Number(buf.readBigUInt64LE(offset + 74));
  const payloadLen = buf.readUInt32LE(offset + 82);
  const payloadStart = offset + HEADER_LEN;
  const end = payloadStart + payloadLen + CRC_LEN;
  if (end > buf.length) {
    fail(`truncated block payload at offset ${offset} (layer ${layer})`, { torn: true, offset });
  }
  const expectedCrc = buf.readUInt32LE(payloadStart + payloadLen);
  const actualCrc = crc32(buf.subarray(offset, payloadStart + payloadLen));
  if (expectedCrc !== actualCrc) {
    fail(`CRC32 mismatch at offset ${offset} (layer ${layer}, type ${type})`, { offset });
  }
  let payload;
  try {
    payload = JSON.parse(buf.subarray(payloadStart, payloadStart + payloadLen).toString('utf8'));
  } catch {
    fail(`invalid JSON payload at offset ${offset} (layer ${layer})`, { offset });
  }
  const raw = buf.subarray(offset, end);
  const block = {
    type,
    layer,
    parentHash,
    txSetHash: txHash,
    selfOffset,
    payload,
    offset,
    length: end - offset,
    hash: sha256(raw),
  };
  return { block, length: end - offset };
}

module.exports = {
  MAGIC,
  VERSION,
  HEADER_LEN,
  CRC_LEN,
  ZERO_HASH,
  TYPES,
  TYPE_NAMES,
  sha256,
  txSetHash,
  encodeBlock,
  decodeBlock,
};
