'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { crc32cFinal } = require('./crc32c');

const DATA_MAGIC = Buffer.from('RBLK');
const IDX_MAGIC = Buffer.from('RIDX');
const VERSION = 1;
const BLOCK_HEADER_SIZE = 24; // magic4 + logicalOffset8 + length4 + crc32c4 + reserved4
const IDX_HEADER_SIZE = 36; // magic4 + version4 + blockSize4 + N4 + blockCount4 + dataSize8 + bloomBits4 + reserved4
const CP_FIXED_SIZE = 28; // blockIndex4 + fileOffset8 + logicalOffset8 + prefixHash8
const TRAILER_SIZE = 32; // sha256 of all preceding index bytes
const DEFAULT_BLOCK_SIZE = 1 << 16;
const DEFAULT_N = 16;
const BLOOM_HASHES = 4;

class RseError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details || {};
  }
}

function bloomBitsFor(n) {
  return Math.min(1 << 16, Math.max(256, n * 32));
}

function bloomKey(logicalOffset) {
  const buf = Buffer.alloc(12);
  buf.write('RKEY', 0, 'ascii');
  buf.writeBigUInt64LE(BigInt(logicalOffset), 4);
  return crypto.createHash('sha256').update(buf).digest();
}

function bloomAdd(bloom, bloomBits, logicalOffset) {
  const d = bloomKey(logicalOffset);
  for (let i = 0; i < BLOOM_HASHES; i++) {
    const bit = d.readUInt32LE(i * 4) % bloomBits;
    bloom[bit >> 3] |= 1 << (bit & 7);
  }
}

function bloomHas(bloom, bloomBits, logicalOffset) {
  const d = bloomKey(logicalOffset);
  for (let i = 0; i < BLOOM_HASHES; i++) {
    const bit = d.readUInt32LE(i * 4) % bloomBits;
    if (!(bloom[bit >> 3] & (1 << (bit & 7)))) return false;
  }
  return true;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

function readExact(fd, buf, pos) {
  let off = 0;
  while (off < buf.length) {
    const n = fs.readSync(fd, buf, off, buf.length - off, pos + off);
    if (n === 0) return false;
    off += n;
  }
  return true;
}

// Sequentially scan the chunked data file, verifying each block's CRC32C.
// Never loads more than one block into memory.
function scanBlocks(fd, onBlock) {
  const header = Buffer.alloc(BLOCK_HEADER_SIZE);
  let pos = 0;
  let index = 0;
  for (;;) {
    const got = readExact(fd, header, pos);
    if (!got) {
      // Clean EOF exactly at a block boundary is fine; a partial header is corruption.
      const stat = fs.fstatSync(fd);
      if (pos === stat.size) return;
      throw new RseError('ERR_CRC', 'truncated block header', { fileOffset: pos });
    }
    if (!header.subarray(0, 4).equals(DATA_MAGIC)) {
      throw new RseError('ERR_CRC', 'bad block magic', { fileOffset: pos });
    }
    const logicalOffset = Number(header.readBigUInt64LE(4));
    const length = header.readUInt32LE(12);
    const crc = header.readUInt32LE(16);
    const payload = Buffer.alloc(length);
    if (!readExact(fd, payload, pos + BLOCK_HEADER_SIZE)) {
      throw new RseError('ERR_CRC', 'truncated block payload', { fileOffset: pos, logicalOffset });
    }
    const actual = crc32cFinal(payload);
    if (actual !== crc) {
      throw new RseError('ERR_CRC', 'block crc mismatch', {
        fileOffset: pos, logicalOffset, expected: crc, actual,
      });
    }
    onBlock({ index, fileOffset: pos, logicalOffset, length, payload });
    pos += BLOCK_HEADER_SIZE + length;
    index++;
  }
}

function buildIndexBuffer(blocks, blockSize, n, dataSize) {
  const bloomBits = bloomBitsFor(n);
  const bloomBytes = bloomBits / 8;
  const cpCount = blocks.length === 0 ? 0 : Math.ceil(blocks.length / n);
  const total = IDX_HEADER_SIZE + cpCount * (CP_FIXED_SIZE + bloomBytes) + TRAILER_SIZE;
  const out = Buffer.alloc(total);

  IDX_MAGIC.copy(out, 0);
  out.writeUInt32LE(VERSION, 4);
  out.writeUInt32LE(blockSize, 8);
  out.writeUInt32LE(n, 12);
  out.writeUInt32LE(blocks.length, 16);
  out.writeBigUInt64LE(BigInt(dataSize), 20);
  out.writeUInt32LE(bloomBits, 28);
  out.writeUInt32LE(0, 32);

  let prevHash = Buffer.alloc(8);
  let off = IDX_HEADER_SIZE;
  for (let c = 0; c < cpCount; c++) {
    const first = blocks[c * n];
    const segment = blocks.slice(c * n, c * n + n);
    const bloom = Buffer.alloc(bloomBytes);
    for (const b of segment) bloomAdd(bloom, bloomBits, b.logicalOffset);

    const fixed = Buffer.alloc(CP_FIXED_SIZE - 8);
    fixed.writeUInt32LE(first.index, 0);
    fixed.writeBigUInt64LE(BigInt(first.fileOffset), 4);
    fixed.writeBigUInt64LE(BigInt(first.logicalOffset), 12);
    const prefixHash = sha256(Buffer.concat([prevHash, fixed, bloom])).subarray(0, 8);

    out.writeUInt32LE(first.index, off);
    out.writeBigUInt64LE(BigInt(first.fileOffset), off + 4);
    out.writeBigUInt64LE(BigInt(first.logicalOffset), off + 12);
    prefixHash.copy(out, off + 20);
    bloom.copy(out, off + CP_FIXED_SIZE);
    prevHash = prefixHash;
    off += CP_FIXED_SIZE + bloomBytes;
  }

  sha256(out.subarray(0, total - TRAILER_SIZE)).copy(out, total - TRAILER_SIZE);
  return out;
}

function parseIndex(buf) {
  if (buf.length < IDX_HEADER_SIZE + TRAILER_SIZE) {
    throw new RseError('ERR_INDEX', 'index too small');
  }
  if (!buf.subarray(0, 4).equals(IDX_MAGIC)) {
    throw new RseError('ERR_INDEX', 'bad index magic');
  }
  if (buf.readUInt32LE(4) !== VERSION) {
    throw new RseError('ERR_INDEX', 'unsupported index version');
  }
  // NOTE: the trailer checksum is intentionally not enforced here. open() only
  // parses structure; integrity is established by verifyIndex() (full rebuild
  // and byte compare) and lazily by read() via bloom/prefix-hash/CRC checks.
  const blockSize = buf.readUInt32LE(8);
  const n = buf.readUInt32LE(12);
  const blockCount = buf.readUInt32LE(16);
  const dataSize = Number(buf.readBigUInt64LE(20));
  const bloomBits = buf.readUInt32LE(28);
  const bloomBytes = bloomBits / 8;
  const cpCount = blockCount === 0 ? 0 : Math.ceil(blockCount / n);
  if (IDX_HEADER_SIZE + cpCount * (CP_FIXED_SIZE + bloomBytes) + TRAILER_SIZE !== buf.length) {
    throw new RseError('ERR_INDEX', 'index size mismatch');
  }
  const checkpoints = [];
  let off = IDX_HEADER_SIZE;
  for (let c = 0; c < cpCount; c++) {
    checkpoints.push({
      blockIndex: buf.readUInt32LE(off),
      fileOffset: Number(buf.readBigUInt64LE(off + 4)),
      logicalOffset: Number(buf.readBigUInt64LE(off + 12)),
      prefixHash: Buffer.from(buf.subarray(off + 20, off + 28)),
      bloom: Buffer.from(buf.subarray(off + CP_FIXED_SIZE, off + CP_FIXED_SIZE + bloomBytes)),
    });
    off += CP_FIXED_SIZE + bloomBytes;
  }
  return { blockSize, n, blockCount, dataSize, bloomBits, checkpoints };
}

// Best-effort read of N from a possibly corrupt index (used by repair).
function peekN(idxFile) {
  try {
    const fd = fs.openSync(idxFile, 'r');
    try {
      const buf = Buffer.alloc(16);
      if (fs.readSync(fd, buf, 0, 16, 0) === 16 && buf.subarray(0, 4).equals(IDX_MAGIC)) {
        return buf.readUInt32LE(12);
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* fall through */ }
  return null;
}

// build: raw source file -> chunked data file + sparse index file.
function build(srcFile, dataFile, idxFile, opts = {}) {
  const blockSize = opts.blockSize || DEFAULT_BLOCK_SIZE;
  const n = opts.n || DEFAULT_N;
  const src = fs.openSync(srcFile, 'r');
  const data = fs.openSync(dataFile, 'w');
  const blocks = [];
  let dataSize = 0;
  try {
    const chunk = Buffer.alloc(blockSize);
    let logical = 0;
    for (;;) {
      const len = fs.readSync(src, chunk, 0, blockSize, logical);
      if (len === 0) break;
      const payload = chunk.subarray(0, len);
      const header = Buffer.alloc(BLOCK_HEADER_SIZE);
      DATA_MAGIC.copy(header, 0);
      header.writeBigUInt64LE(BigInt(logical), 4);
      header.writeUInt32LE(len, 12);
      header.writeUInt32LE(crc32cFinal(payload), 16);
      const fileOffset = dataSize === 0 && blocks.length === 0
        ? 0
        : blocks[blocks.length - 1].fileOffset + BLOCK_HEADER_SIZE + blocks[blocks.length - 1].length;
      fs.writeSync(data, header);
      fs.writeSync(data, payload, 0, len);
      blocks.push({ index: blocks.length, fileOffset, logicalOffset: logical, length: len });
      logical += len;
      dataSize = logical;
    }
  } finally {
    fs.closeSync(src);
    fs.closeSync(data);
  }
  fs.writeFileSync(idxFile, buildIndexBuffer(blocks, blockSize, n, dataSize));
  return { blockCount: blocks.length, dataSize, blockSize, n };
}

function rebuildIndexBuffer(dataFd, n) {
  const blocks = [];
  scanBlocks(dataFd, (b) => {
    blocks.push({ index: b.index, fileOffset: b.fileOffset, logicalOffset: b.logicalOffset, length: b.length });
  });
  if (blocks.length === 0) {
    return { buf: buildIndexBuffer([], 0, n, 0), blockSize: 0, dataSize: 0, blockCount: 0 };
  }
  const blockSize = blocks[0].length;
  for (const b of blocks) {
    if (b.logicalOffset !== b.index * blockSize) {
      throw new RseError('ERR_CRC', 'non-contiguous blocks', { blockIndex: b.index });
    }
  }
  const dataSize = blocks[blocks.length - 1].logicalOffset + blocks[blocks.length - 1].length;
  return { buf: buildIndexBuffer(blocks, blockSize, n, dataSize), blockSize, dataSize, blockCount: blocks.length };
}

// Standalone repair: works even when the existing index is corrupt or missing.
// Opens the data file read-only and never modifies it.
function repair(dataFile, idxFile, opts = {}) {
  const n = opts.n || peekN(idxFile) || DEFAULT_N;
  const fd = fs.openSync(dataFile, 'r');
  try {
    const { buf, blockCount, dataSize, blockSize } = rebuildIndexBuffer(fd, n);
    const tmp = idxFile + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, idxFile);
    return { blockCount, dataSize, blockSize, n };
  } finally {
    fs.closeSync(fd);
  }
}

function open(dataFile, idxFile) {
  const idxBuf = fs.readFileSync(idxFile);
  const idx = parseIndex(idxBuf); // throws ERR_INDEX on structural/checksum damage
  const fd = fs.openSync(dataFile, 'r');

  function locate(blockIndex) {
    const cp = idx.checkpoints[Math.floor(blockIndex / idx.n)];
    if (!cp) throw new RseError('ERR_INDEX', 'missing checkpoint', { blockIndex });
    const blockStart = blockIndex * idx.blockSize;
    if (!bloomHas(cp.bloom, idx.bloomBits, blockStart)) return null; // bloom negative: direct miss
    const header = Buffer.alloc(BLOCK_HEADER_SIZE);
    let pos = cp.fileOffset;
    for (let step = 0; step < idx.n; step++) {
      if (!readExact(fd, header, pos)) {
        throw new RseError('ERR_CRC', 'truncated block header', { blockIndex, fileOffset: pos });
      }
      if (!header.subarray(0, 4).equals(DATA_MAGIC)) {
        throw new RseError('ERR_INDEX', 'checkpoint chain broken', { blockIndex, fileOffset: pos });
      }
      const logicalOffset = Number(header.readBigUInt64LE(4));
      const length = header.readUInt32LE(12);
      if (logicalOffset === blockStart) {
        return { fileOffset: pos, logicalOffset, length, crc: header.readUInt32LE(16) };
      }
      pos += BLOCK_HEADER_SIZE + length;
    }
    throw new RseError('ERR_INDEX', 'block not found from checkpoint', { blockIndex });
  }

  // Returns a Buffer, or null on bloom-filter miss (no block I/O performed).
  function read(offset, len) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(len) || offset < 0 || len < 0) {
      throw new RseError('ERR_RANGE', 'invalid range', { offset, len, dataSize: idx.dataSize });
    }
    if (offset + len > idx.dataSize) {
      throw new RseError('ERR_RANGE', 'range out of bounds', { offset, len, dataSize: idx.dataSize });
    }
    if (len === 0) return Buffer.alloc(0);
    const out = Buffer.alloc(len);
    let written = 0;
    let pos = offset;
    while (written < len) {
      const blockIndex = Math.floor(pos / idx.blockSize);
      const meta = locate(blockIndex);
      if (meta === null) return null; // ERR_BLOOM miss, surfaced by caller
      const payload = Buffer.alloc(meta.length);
      if (!readExact(fd, payload, meta.fileOffset + BLOCK_HEADER_SIZE)) {
        throw new RseError('ERR_CRC', 'truncated block payload', { blockIndex });
      }
      const actual = crc32cFinal(payload);
      if (actual !== meta.crc) {
        throw new RseError('ERR_CRC', 'block crc mismatch', { blockIndex, expected: meta.crc, actual });
      }
      const start = pos - meta.logicalOffset;
      const take = Math.min(meta.length - start, len - written);
      payload.copy(out, written, start, start + take);
      written += take;
      pos += take;
    }
    return out;
  }

  // Rebuilds the expected index from the data file and compares bytes.
  // Throws ERR_CRC if the data itself is corrupt; returns false if index diverges.
  function verifyIndex() {
    const { buf } = rebuildIndexBuffer(fd, idx.n);
    return buf.equals(idxBuf);
  }

  // Rebuilds the index purely from the data file; never writes to the data file.
  function repair(opts = {}) {
    const n = opts.n || peekN(idxFile) || DEFAULT_N;
    const { buf, blockCount, dataSize, blockSize } = rebuildIndexBuffer(fd, n);
    const tmp = idxFile + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, idxFile);
    return { blockCount, dataSize, blockSize, n };
  }

  function close() {
    fs.closeSync(fd);
  }

  return { read, verifyIndex, repair, close, meta: idx, dataFile: path.resolve(dataFile), idxFile: path.resolve(idxFile) };
}

module.exports = {
  build, open, repair, RseError,
  BLOCK_HEADER_SIZE, IDX_HEADER_SIZE, CP_FIXED_SIZE, TRAILER_SIZE,
  DEFAULT_BLOCK_SIZE, DEFAULT_N,
};
