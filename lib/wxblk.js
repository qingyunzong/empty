'use strict';
// wxblk: append-only block stream for weather observations with corrections,
// undo, per-block index footers and a global sha256 hash chain.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { crc32c } = require('./crc32c');

const FILE_MAGIC = Buffer.from('WXBLK001'); // 8 bytes, file header
const BLOCK_MAGIC = 0x314b4c42; // 'BLK1' little-endian
const FOOTER_MAGIC = 0x31584449; // 'IDX1' little-endian
const HEADER_LEN = 72;
const FOOTER_LEN = 32;
const NONE = 0xffffffffffffffffn;

const TYPE = { DATA: 0, CORRECTION: 1, UNDO: 2 };
const TYPE_NAME = { 0: 'data', 1: 'correction', 2: 'undo' };

class WxError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();
const GENESIS_HASH = sha256(FILE_MAGIC);

// ---- block encoding -------------------------------------------------------

function encodeBlock({ blockId, type, timestamp, replacesId, payload, prevHash, offset }) {
  const header = Buffer.alloc(HEADER_LEN);
  header.writeUInt32LE(BLOCK_MAGIC, 0);
  header.writeUInt8(1, 4); // version
  header.writeUInt8(type, 5);
  header.writeUInt16LE(0, 6); // flags
  header.writeBigUInt64LE(BigInt(blockId), 8);
  header.writeBigUInt64LE(BigInt(timestamp), 16);
  header.writeBigUInt64LE(replacesId == null ? NONE : BigInt(replacesId), 24);
  header.writeUInt32LE(payload.length, 32);
  // bytes 36..39 reserved (zero)
  prevHash.copy(header, 40); // 32 bytes at offset 40..71

  const body = Buffer.concat([header, payload]);
  const crc = crc32c(body);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32LE(crc, 0);

  const blockLen = HEADER_LEN + payload.length + 4;
  const footer = Buffer.alloc(FOOTER_LEN);
  footer.writeBigUInt64LE(BigInt(blockId), 0);
  footer.writeBigUInt64LE(BigInt(offset), 8);
  footer.writeBigUInt64LE(BigInt(blockLen), 16);
  footer.writeUInt32LE(FOOTER_MAGIC, 24);
  footer.writeUInt32LE(crc32c(footer.subarray(0, 28)), 28);

  return Buffer.concat([body, crcBuf, footer]);
}

// ---- scanning -------------------------------------------------------------

// Parses a buffer into blocks. Never throws on bad CRC / truncation; those are
// reported in the result. Throws WxError(ERR_FORMAT) only when the file magic
// or a block header magic is unrecognisable.
function scanBuffer(buf) {
  if (buf.length < FILE_MAGIC.length || !buf.subarray(0, 8).equals(FILE_MAGIC)) {
    throw new WxError('ERR_FORMAT', 'bad or missing file magic');
  }
  const blocks = [];
  const indexDiffs = [];
  let truncated = null;
  let offset = FILE_MAGIC.length;
  let prevHash = GENESIS_HASH;

  while (offset < buf.length) {
    const remaining = buf.length - offset;
    if (remaining < HEADER_LEN) {
      truncated = { offset, reason: 'partial-header', expectedBytes: HEADER_LEN, availableBytes: remaining };
      break;
    }
    const header = buf.subarray(offset, offset + HEADER_LEN);
    if (header.readUInt32LE(0) !== BLOCK_MAGIC) {
      throw new WxError('ERR_FORMAT', `bad block magic at offset ${offset}`, { offset });
    }
    const type = header.readUInt8(5);
    const blockId = Number(header.readBigUInt64LE(8));
    const timestamp = Number(header.readBigUInt64LE(16));
    const replacesRaw = header.readBigUInt64LE(24);
    const replacesId = replacesRaw === NONE ? null : Number(replacesRaw);
    const payloadLen = header.readUInt32LE(32);
    const prevHashStored = Buffer.from(header.subarray(40, 72));

    const blockLen = HEADER_LEN + payloadLen + 4;
    if (remaining < blockLen) {
      truncated = { offset, reason: 'partial-payload', expectedBytes: blockLen, availableBytes: remaining };
      break;
    }
    const raw = buf.subarray(offset, offset + HEADER_LEN + payloadLen); // header+payload
    const payload = Buffer.from(buf.subarray(offset + HEADER_LEN, offset + HEADER_LEN + payloadLen));
    const storedCrc = buf.readUInt32LE(offset + HEADER_LEN + payloadLen);
    const computedCrc = crc32c(raw);
    const crcOk = storedCrc === computedCrc;
    const hash = sha256(raw);
    const chainOk = prevHashStored.equals(prevHash);

    // index footer
    let footer = null;
    if (remaining < blockLen + FOOTER_LEN) {
      truncated = { offset, reason: 'partial-footer', expectedBytes: blockLen + FOOTER_LEN, availableBytes: remaining };
      // block itself is complete; still record it, then stop
      blocks.push({ blockId, type, timestamp, replacesId, payload, offset, blockLen, crcOk, storedCrc, computedCrc, hash, chainOk, prevHashStored, footer: null });
      break;
    }
    const f = buf.subarray(offset + blockLen, offset + blockLen + FOOTER_LEN);
    const fBlockId = Number(f.readBigUInt64LE(0));
    const fOffset = Number(f.readBigUInt64LE(8));
    const fBlockLen = Number(f.readBigUInt64LE(16));
    const fMagic = f.readUInt32LE(24);
    const fCrc = f.readUInt32LE(28);
    const fCrcOk = fCrc === crc32c(f.subarray(0, 28));
    footer = { blockId: fBlockId, offset: fOffset, blockLen: fBlockLen, magicOk: fMagic === FOOTER_MAGIC, crcOk: fCrcOk };
    const expected = { blockId, offset, blockLen };
    if (!footer.magicOk || !footer.crcOk || fBlockId !== expected.blockId || fOffset !== expected.offset || fBlockLen !== expected.blockLen) {
      indexDiffs.push({
        block: blockId, offset,
        expected,
        actual: { blockId: fBlockId, offset: fOffset, blockLen: fBlockLen, magicOk: footer.magicOk, crcOk: fCrcOk },
      });
    }

    blocks.push({ blockId, type, timestamp, replacesId, payload, offset, blockLen, crcOk, storedCrc, computedCrc, hash, chainOk, prevHashStored, footer });
    prevHash = hash;
    offset += blockLen + FOOTER_LEN;
  }

  return { blocks, truncated, indexDiffs };
}

function readFileBuf(file) {
  try {
    return fs.readFileSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') throw new WxError('ERR_FORMAT', `file not found: ${file}`);
    throw e;
  }
}

function scan(file) {
  const { blocks, truncated, indexDiffs } = scanBuffer(readFileBuf(file));
  return {
    file,
    blocks: blocks.map(publicBlock),
    truncated,
    indexDiffs,
    rebuiltIndex: blocks.map((b) => ({ blockId: b.blockId, offset: b.offset, blockLen: b.blockLen })),
  };
}

function publicBlock(b) {
  return {
    blockId: b.blockId,
    type: TYPE_NAME[b.type] ?? `unknown(${b.type})`,
    timestamp: b.timestamp,
    replacesId: b.replacesId,
    offset: b.offset,
    blockLen: b.blockLen,
    crcOk: b.crcOk,
    chainOk: b.chainOk,
    payloadPreview: b.payload.toString('utf8').slice(0, 64),
  };
}

// ---- mutation -------------------------------------------------------------

function loadForAppend(file) {
  if (!fs.existsSync(file)) return { buf: FILE_MAGIC, blocks: [], prevHash: GENESIS_HASH };
  const buf = readFileBuf(file);
  const { blocks, truncated } = scanBuffer(buf);
  if (truncated) {
    throw new WxError('ERR_FORMAT', `file has truncated tail at offset ${truncated.offset}; refusing to append`, truncated);
  }
  const prevHash = blocks.length ? blocks[blocks.length - 1].hash : GENESIS_HASH;
  return { buf, blocks, prevHash };
}

function appendBlock(file, fields) {
  const { buf, blocks, prevHash } = loadForAppend(file);
  const blockId = blocks.length ? blocks[blocks.length - 1].blockId + 1 : 0;
  const blk = encodeBlock({ ...fields, blockId, prevHash, offset: buf.length });
  fs.writeFileSync(file, Buffer.concat([buf, blk]));
  return { blockId, type: TYPE_NAME[fields.type] };
}

function append(file, payload, opts = {}) {
  return appendBlock(file, {
    type: TYPE.DATA,
    timestamp: opts.ts ?? Date.now(),
    replacesId: null,
    payload: toPayload(payload),
  });
}

function toPayload(p) {
  return Buffer.isBuffer(p) ? p : Buffer.from(String(p), 'utf8');
}

// ---- view / history semantics --------------------------------------------

// Builds logical state from physically scanned blocks (CRC-bad blocks skipped).
function buildState(blocks) {
  const valid = blocks.filter((b) => b.crcOk);
  const byId = new Map(valid.map((b) => [b.blockId, b]));
  const undone = new Set();
  for (const b of valid) if (b.type === TYPE.UNDO && byId.has(b.replacesId)) undone.add(b.replacesId);

  const resolveRoot = (id) => {
    let cur = byId.get(id);
    const seen = new Set();
    while (cur && cur.type === TYPE.CORRECTION && !seen.has(cur.blockId)) {
      seen.add(cur.blockId);
      cur = byId.get(cur.replacesId);
    }
    return cur && cur.type === TYPE.DATA ? cur.blockId : null;
  };

  // newest active correction per root
  const effective = new Map(); // rootId -> correcting block
  for (const b of valid) {
    if (b.type !== TYPE.CORRECTION || undone.has(b.blockId)) continue;
    const root = resolveRoot(b.blockId);
    if (root == null) continue;
    effective.set(root, b); // blocks arrive in id order -> last wins
  }

  const records = [];
  for (const b of valid) {
    if (b.type !== TYPE.DATA) continue;
    const corr = effective.get(b.blockId);
    records.push({
      id: b.blockId,
      payload: corr ? corr.payload : b.payload,
      timestamp: corr ? corr.timestamp : b.timestamp,
      corrected: !!corr,
      correctedBy: corr ? corr.blockId : null,
    });
  }
  return { byId, undone, records, resolveRoot };
}

function correct(file, id, newPayload, opts = {}) {
  const { blocks } = loadForAppend(file);
  const state = buildState(blocks);
  const target = state.byId.get(id);
  if (!target || (target.type !== TYPE.DATA && target.type !== TYPE.CORRECTION)) {
    throw new WxError('ERR_RANGE', `no correctable block with id ${id}`, { id });
  }
  return appendBlock(file, {
    type: TYPE.CORRECTION,
    timestamp: opts.ts ?? Date.now(),
    replacesId: id,
    payload: toPayload(newPayload),
  });
}

function undo(file, correctId, opts = {}) {
  const { blocks } = loadForAppend(file);
  const state = buildState(blocks);
  const target = state.byId.get(correctId);
  if (!target || target.type !== TYPE.CORRECTION) {
    throw new WxError('ERR_RANGE', `no correction with id ${correctId}`, { correctId });
  }
  if (state.undone.has(correctId)) {
    throw new WxError('ERR_CONFLICT', `correction ${correctId} is already undone`, { correctId });
  }
  // conflict: an active correction directly builds on this one's output
  for (const b of state.byId.values()) {
    if (b.type === TYPE.CORRECTION && !state.undone.has(b.blockId) && b.replacesId === correctId) {
      throw new WxError('ERR_CONFLICT', `correction ${correctId} is depended on by correction ${b.blockId}`, {
        correctId, dependent: b.blockId,
      });
    }
  }
  return appendBlock(file, {
    type: TYPE.UNDO,
    timestamp: opts.ts ?? Date.now(),
    replacesId: correctId,
    payload: Buffer.alloc(0),
  });
}

// ---- verify ---------------------------------------------------------------

function verify(file) {
  const { blocks, truncated, indexDiffs } = scanBuffer(readFileBuf(file));
  const crcErrors = blocks.filter((b) => !b.crcOk)
    .map((b) => ({ code: 'ERR_CRC', block: b.blockId, offset: b.offset, stored: b.storedCrc, computed: b.computedCrc }));
  const chainBreaks = blocks.filter((b) => !b.chainOk)
    .map((b) => ({ block: b.blockId, offset: b.offset }));
  const ok = chainBreaks.length === 0;
  const result = {
    file, ok,
    blocksChecked: blocks.length,
    crcErrors, // bad-CRC blocks are skipped, not fatal
    chainBreaks,
    truncated,
    indexDiffs,
  };
  if (!ok) {
    throw new WxError('ERR_CHAIN', `hash chain broken at block ${chainBreaks[0].block}`, result);
  }
  return result;
}

// ---- decode ---------------------------------------------------------------

function decode(file, range = {}) {
  const { blocks } = scanBuffer(readFileBuf(file));
  const state = buildState(blocks);
  let records = state.records;
  if (range.since != null || range.until != null) {
    const since = range.since ?? -Infinity;
    const until = range.until ?? Infinity;
    records = records.filter((r) => r.timestamp >= since && r.timestamp <= until);
  }
  const from = range.from ?? 0;
  const to = range.to ?? records.length - 1;
  if (range.from != null || range.to != null) {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > to || to >= records.length) {
      throw new WxError('ERR_RANGE', `invalid range [${range.from ?? '-'}, ${range.to ?? '-'}] for ${records.length} record(s)`, {
        from: range.from ?? null, to: range.to ?? null, records: records.length,
      });
    }
  }
  return records.slice(from, to + 1).map((r) => ({
    id: r.id,
    timestamp: r.timestamp,
    corrected: r.corrected,
    correctedBy: r.correctedBy,
    payload: r.payload.toString('utf8'),
  }));
}

module.exports = {
  TYPE, WxError, scanBuffer, scan, append, correct, undo, verify, decode,
  buildState, encodeBlock, FILE_MAGIC, HEADER_LEN, FOOTER_LEN,
};
