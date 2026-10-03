'use strict';
// 遥感大文件分块存储 + 稀疏可信索引库（仅标准库，单机离线）。
//
// 数据文件布局:
//   [0..8)   magic "RSDAT01\0"
//   [8..12)  u32 blockSize   每块载荷字节数(末块可短)
//   [12..16) u32 interval    每 N 块一个索引检查点
//   随后为块序列, 每块: 16 字节块头 + 载荷
//     块头: u64 payloadOffset | u32 length | u32 crc32c(payload)
//
// 索引文件布局:
//   [0..8)   magic "RSIDX01\0"
//   u32 version=1 | u32 interval | u32 blockSize
//   u64 blockCount | u64 dataSize(载荷总字节数)
//   u32 checkpointCount | u32 bloomBytes
//   checkpoint[checkpointCount]:
//     u64 blockIndex | u64 fileOffset | u32 prefixHash | bloom[bloomBytes] | u32 entryCrc
//   u32 indexCrc (对之前全部字节)
//
// prefixHash: 对本检查点之前全部块(块头+载荷)的 crc32c 链式哈希。
// bloom: 本段内各块全局块号的采样布隆位图(双哈希 3 探针)。

const fs = require('node:fs');

const DATA_MAGIC = Buffer.from('RSDAT01\0', 'latin1');
const INDEX_MAGIC = Buffer.from('RSIDX01\0', 'latin1');
const DATA_HEADER_SIZE = 16;
const BLOCK_HEADER_SIZE = 16;
const INDEX_HEADER_SIZE = 44;
const BLOOM_BYTES = 64;
const BLOOM_BITS = BLOOM_BYTES * 8;
const CHECKPOINT_SIZE = 8 + 8 + 4 + BLOOM_BYTES + 4;
const INDEX_VERSION = 1;

// ---------- CRC32C (Castagnoli, 反射多项式 0x82F63B78) ----------
const CRC32C_TABLE = (() => {
  const poly = 0x82f63b78;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ poly : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32c(buf, crc = 0) {
  let c = ~crc;
  for (let i = 0; i < buf.length; i++) {
    c = CRC32C_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return ~c >>> 0;
}

// ---------- 错误 ----------
class RsError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'RsError';
    this.code = code;
    if (details) Object.assign(this, details);
  }
}
const errIndex = (msg, d) => new RsError('ERR_INDEX', msg, d);
const errCrc = (msg, d) => new RsError('ERR_CRC', msg, d);
const errRange = (msg, d) => new RsError('ERR_RANGE', msg, d);
const errBloom = (msg, d) => new RsError('ERR_BLOOM', msg, d);

// ---------- 布隆位图 ----------
function bloomKey(blockIndex) {
  const key = Buffer.allocUnsafe(8);
  key.writeBigUInt64LE(BigInt(blockIndex));
  return key;
}
function bloomAdd(bitmap, key) {
  const h1 = crc32c(key, 0);
  const h2 = crc32c(key, 0x9e3779b9) || 1;
  for (let i = 0; i < 3; i++) {
    const bit = (h1 + i * h2) % BLOOM_BITS;
    bitmap[bit >> 3] |= 1 << (bit & 7);
  }
}
function bloomHas(bitmap, key) {
  const h1 = crc32c(key, 0);
  const h2 = crc32c(key, 0x9e3779b9) || 1;
  for (let i = 0; i < 3; i++) {
    const bit = (h1 + i * h2) % BLOOM_BITS;
    if (!(bitmap[bit >> 3] & (1 << (bit & 7)))) return false;
  }
  return true;
}

// ---------- 数据文件 ----------
function writeDataFile(srcPath, dataPath, blockSize, interval) {
  const srcFd = fs.openSync(srcPath, 'r');
  const dataFd = fs.openSync(dataPath, 'w');
  try {
    const header = Buffer.allocUnsafe(DATA_HEADER_SIZE);
    DATA_MAGIC.copy(header, 0);
    header.writeUInt32LE(blockSize, 8);
    header.writeUInt32LE(interval, 12);
    fs.writeSync(dataFd, header, 0, DATA_HEADER_SIZE, 0);

    const payload = Buffer.allocUnsafe(blockSize);
    const blockHeader = Buffer.allocUnsafe(BLOCK_HEADER_SIZE);
    let pos = DATA_HEADER_SIZE;
    let blockCount = 0;
    let dataSize = 0;
    for (;;) {
      const n = fs.readSync(srcFd, payload, 0, blockSize, blockCount * blockSize);
      if (n === 0) break;
      const view = payload.subarray(0, n);
      blockHeader.writeBigUInt64LE(BigInt(pos + BLOCK_HEADER_SIZE), 0);
      blockHeader.writeUInt32LE(n, 8);
      blockHeader.writeUInt32LE(crc32c(view), 12);
      fs.writeSync(dataFd, blockHeader, 0, BLOCK_HEADER_SIZE, pos);
      fs.writeSync(dataFd, view, 0, n, pos + BLOCK_HEADER_SIZE);
      pos += BLOCK_HEADER_SIZE + n;
      dataSize += n;
      blockCount++;
    }
    return { blockCount, dataSize };
  } finally {
    fs.closeSync(srcFd);
    fs.closeSync(dataFd);
  }
}

function readDataHeader(fd) {
  const header = Buffer.allocUnsafe(DATA_HEADER_SIZE);
  const n = fs.readSync(fd, header, 0, DATA_HEADER_SIZE, 0);
  if (n < DATA_HEADER_SIZE || !header.subarray(0, 8).equals(DATA_MAGIC)) {
    throw errIndex('bad data file header');
  }
  const blockSize = header.readUInt32LE(8);
  const interval = header.readUInt32LE(12);
  if (blockSize === 0 || interval === 0) throw errIndex('bad data file parameters');
  return { blockSize, interval };
}

// 从数据文件流式重建索引字节(确定性, repair/verify 共用)。绝不写数据文件。
function buildIndexBuffer(dataPath) {
  const fd = fs.openSync(dataPath, 'r');
  try {
    const { blockSize, interval } = readDataHeader(fd);
    const fileSize = fs.fstatSync(fd).size;

    const checkpoints = [];
    let bloom = null;
    let prefixHash = 0;
    let blockCount = 0;
    let dataSize = 0;

    const headerBuf = Buffer.allocUnsafe(BLOCK_HEADER_SIZE);
    let pos = DATA_HEADER_SIZE;
    while (pos < fileSize) {
      const n = fs.readSync(fd, headerBuf, 0, BLOCK_HEADER_SIZE, pos);
      if (n < BLOCK_HEADER_SIZE) {
        throw errIndex('truncated block header', { blockIndex: blockCount, offset: pos });
      }
      const payloadOffset = Number(headerBuf.readBigUInt64LE(0));
      const length = headerBuf.readUInt32LE(8);
      const crc = headerBuf.readUInt32LE(12);
      if (payloadOffset !== pos + BLOCK_HEADER_SIZE) {
        throw errIndex('block header offset mismatch', { blockIndex: blockCount, offset: pos });
      }
      if (length === 0 || length > blockSize) {
        throw errIndex('block length out of bounds', { blockIndex: blockCount, length });
      }
      if (pos + BLOCK_HEADER_SIZE + length > fileSize) {
        throw errIndex('truncated block payload', { blockIndex: blockCount });
      }
      const payload = Buffer.allocUnsafe(length);
      const got = fs.readSync(fd, payload, 0, length, pos + BLOCK_HEADER_SIZE);
      if (got < length) throw errIndex('short read on payload', { blockIndex: blockCount });
      if (crc32c(payload) !== crc) {
        throw errCrc('block payload crc mismatch', { blockIndex: blockCount });
      }

      if (blockCount % interval === 0) {
        bloom = Buffer.alloc(BLOOM_BYTES);
        checkpoints.push({ blockIndex: blockCount, fileOffset: pos, prefixHash, bloom });
      }
      bloomAdd(bloom, bloomKey(blockCount));
      prefixHash = crc32c(payload, crc32c(headerBuf, prefixHash));

      pos += BLOCK_HEADER_SIZE + length;
      dataSize += length;
      blockCount++;
    }

    const out = Buffer.allocUnsafe(INDEX_HEADER_SIZE + checkpoints.length * CHECKPOINT_SIZE + 4);
    INDEX_MAGIC.copy(out, 0);
    out.writeUInt32LE(INDEX_VERSION, 8);
    out.writeUInt32LE(interval, 12);
    out.writeUInt32LE(blockSize, 16);
    out.writeBigUInt64LE(BigInt(blockCount), 20);
    out.writeBigUInt64LE(BigInt(dataSize), 28);
    out.writeUInt32LE(checkpoints.length, 36);
    out.writeUInt32LE(BLOOM_BYTES, 40);
    let p = INDEX_HEADER_SIZE;
    for (const cp of checkpoints) {
      out.writeBigUInt64LE(BigInt(cp.blockIndex), p);
      out.writeBigUInt64LE(BigInt(cp.fileOffset), p + 8);
      out.writeUInt32LE(cp.prefixHash, p + 16);
      cp.bloom.copy(out, p + 20);
      out.writeUInt32LE(crc32c(out.subarray(p, p + 20 + BLOOM_BYTES)), p + 20 + BLOOM_BYTES);
      p += CHECKPOINT_SIZE;
    }
    out.writeUInt32LE(crc32c(out.subarray(0, p)), p);
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

function parseIndex(buf) {
  if (buf.length < INDEX_HEADER_SIZE + 4 || !buf.subarray(0, 8).equals(INDEX_MAGIC)) {
    throw errIndex('bad index magic');
  }
  if (buf.readUInt32LE(8) !== INDEX_VERSION) throw errIndex('unsupported index version');
  const interval = buf.readUInt32LE(12);
  const blockSize = buf.readUInt32LE(16);
  const blockCount = Number(buf.readBigUInt64LE(20));
  const dataSize = Number(buf.readBigUInt64LE(28));
  const checkpointCount = buf.readUInt32LE(36);
  const bloomBytes = buf.readUInt32LE(40);
  if (interval === 0 || blockSize === 0 || bloomBytes !== BLOOM_BYTES) {
    throw errIndex('bad index header fields');
  }
  if (buf.length !== INDEX_HEADER_SIZE + checkpointCount * CHECKPOINT_SIZE + 4) {
    throw errIndex('index size mismatch');
  }
  if (crc32c(buf.subarray(0, buf.length - 4)) !== buf.readUInt32LE(buf.length - 4)) {
    throw errIndex('index crc mismatch');
  }
  const checkpoints = [];
  let p = INDEX_HEADER_SIZE;
  for (let i = 0; i < checkpointCount; i++) {
    const entry = buf.subarray(p, p + CHECKPOINT_SIZE);
    if (crc32c(entry.subarray(0, CHECKPOINT_SIZE - 4)) !== entry.readUInt32LE(CHECKPOINT_SIZE - 4)) {
      throw errIndex('checkpoint crc mismatch', { checkpoint: i });
    }
    const blockIndex = Number(entry.readBigUInt64LE(0));
    if (blockIndex !== i * interval) throw errIndex('checkpoint blockIndex mismatch', { checkpoint: i });
    checkpoints.push({
      blockIndex,
      fileOffset: Number(entry.readBigUInt64LE(8)),
      prefixHash: entry.readUInt32LE(16),
      bloom: Buffer.from(entry.subarray(20, 20 + BLOOM_BYTES)),
    });
    p += CHECKPOINT_SIZE;
  }
  if (checkpointCount !== Math.ceil(blockCount / interval) && !(blockCount === 0 && checkpointCount === 0)) {
    throw errIndex('checkpoint count inconsistent with blockCount');
  }
  return { interval, blockSize, blockCount, dataSize, checkpoints };
}

// ---------- 公开 API ----------

function build(srcPath, dataPath, idxPath, opts = {}) {
  const blockSize = opts.blockSize ?? 65536;
  const interval = opts.interval ?? 16;
  if (!Number.isSafeInteger(blockSize) || blockSize <= 0) throw errRange('bad blockSize');
  if (!Number.isSafeInteger(interval) || interval <= 0) throw errRange('bad interval');
  const stats = writeDataFile(srcPath, dataPath, blockSize, interval);
  fs.writeFileSync(idxPath, buildIndexBuffer(dataPath));
  return { ...stats, blockSize, interval };
}

function open(dataPath, idxPath) {
  const dataFd = fs.openSync(dataPath, 'r');
  try {
    const dataHeader = readDataHeader(dataFd);
    const index = parseIndex(fs.readFileSync(idxPath));
    if (index.blockSize !== dataHeader.blockSize || index.interval !== dataHeader.interval) {
      throw errIndex('index does not match data file parameters');
    }

    function readBlockPayload(target) {
      const cp = index.checkpoints[Math.floor(target / index.interval)];
      if (!cp) throw errIndex('missing checkpoint', { blockIndex: target });
      // 布隆阴性 -> 直接 miss, 不触碰数据文件
      if (!bloomHas(cp.bloom, bloomKey(target))) {
        throw errBloom('bloom negative: block not in segment', { blockIndex: target });
      }
      // 布隆阳性 -> 仅从检查点顺序走块头定位, 并读块做 CRC 确认
      const headerBuf = Buffer.allocUnsafe(BLOCK_HEADER_SIZE);
      let pos = cp.fileOffset;
      for (let bi = cp.blockIndex;; bi++) {
        const n = fs.readSync(dataFd, headerBuf, 0, BLOCK_HEADER_SIZE, pos);
        if (n < BLOCK_HEADER_SIZE) throw errIndex('eof walking to block', { blockIndex: target });
        const payloadOffset = Number(headerBuf.readBigUInt64LE(0));
        const length = headerBuf.readUInt32LE(8);
        if (payloadOffset !== pos + BLOCK_HEADER_SIZE || length === 0 || length > index.blockSize) {
          throw errIndex('block header inconsistent with index', { blockIndex: bi });
        }
        if (bi === target) {
          const payload = Buffer.allocUnsafe(length);
          const got = fs.readSync(dataFd, payload, 0, length, payloadOffset);
          if (got < length) throw errIndex('eof reading payload', { blockIndex: target });
          if (crc32c(payload) !== headerBuf.readUInt32LE(12)) {
            throw errCrc('payload crc mismatch', { blockIndex: target });
          }
          return payload;
        }
        pos += BLOCK_HEADER_SIZE + length;
      }
    }

    return {
      dataPath,
      idxPath,
      blockSize: index.blockSize,
      interval: index.interval,
      blockCount: index.blockCount,
      dataSize: index.dataSize,

      read(offset, length) {
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
          throw errRange('offset/length must be non-negative safe integers', { offset, length });
        }
        if (offset + length > index.dataSize) {
          throw errRange('range out of bounds', { offset, length, dataSize: index.dataSize });
        }
        if (length === 0) return Buffer.alloc(0);
        const firstBlock = Math.floor(offset / index.blockSize);
        const lastBlock = Math.floor((offset + length - 1) / index.blockSize);
        const parts = [];
        for (let b = firstBlock; b <= lastBlock; b++) {
          const payload = readBlockPayload(b);
          const start = b === firstBlock ? offset - b * index.blockSize : 0;
          const end = b === lastBlock ? offset + length - b * index.blockSize : payload.length;
          parts.push(payload.subarray(start, end));
        }
        return parts.length === 1 ? Buffer.from(parts[0]) : Buffer.concat(parts);
      },

      verifyIndex() {
        const expected = buildIndexBuffer(dataPath);
        const actual = fs.readFileSync(idxPath);
        if (!expected.equals(actual)) {
          throw errIndex('index does not match data (tampered or stale)');
        }
        return true;
      },

      repair() {
        // 只从数据重建索引; 绝不修改数据文件
        const rebuilt = buildIndexBuffer(dataPath);
        fs.writeFileSync(idxPath, rebuilt);
        return { checkpointCount: rebuilt.readUInt32LE(36), bytes: rebuilt.length };
      },

      close() {
        fs.closeSync(dataFd);
      },
    };
  } catch (e) {
    fs.closeSync(dataFd);
    throw e;
  }
}

// 独立版 verify/repair: 不要求现有索引可解析(索引可能已损坏)。
function verifyIndex(dataPath, idxPath) {
  const expected = buildIndexBuffer(dataPath);
  let actual;
  try {
    actual = fs.readFileSync(idxPath);
  } catch {
    throw errIndex('index file unreadable');
  }
  if (!expected.equals(actual)) {
    throw errIndex('index does not match data (tampered or stale)');
  }
  return true;
}

function repair(dataPath, idxPath) {
  // 只从数据重建索引; 绝不修改数据文件
  const rebuilt = buildIndexBuffer(dataPath);
  fs.writeFileSync(idxPath, rebuilt);
  return { checkpointCount: rebuilt.readUInt32LE(36), bytes: rebuilt.length };
}

module.exports = {
  build,
  open,
  verifyIndex,
  repair,
  crc32c,
  RsError,
  constants: { DATA_HEADER_SIZE, BLOCK_HEADER_SIZE, INDEX_HEADER_SIZE, BLOOM_BYTES, CHECKPOINT_SIZE },
};
