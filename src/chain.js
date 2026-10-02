'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { crc32 } = require('./crc32');

const GENESIS_HASH = '0'.repeat(64);
const HEADER_LEN = 4; // uint32 LE body length
const CRC_LEN = 4; // uint32 LE crc32 of body
const MAX_BODY = 64 * 1024 * 1024;

class ChainError extends Error {
  constructor(message, offset) {
    super(message);
    this.name = 'ChainError';
    this.offset = offset;
  }
}

function logPath(dir) {
  return path.join(dir, 'batches.log');
}

function indexPath(dir) {
  return path.join(dir, 'batches.idx');
}

// A block record on disk: [len(4)][body JSON bytes][crc32(body)(4)].
// The block hash covers the whole record.
function encodeRecord(body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const record = Buffer.alloc(HEADER_LEN + payload.length + CRC_LEN);
  record.writeUInt32LE(payload.length, 0);
  payload.copy(record, HEADER_LEN);
  record.writeUInt32LE(crc32(payload), HEADER_LEN + payload.length);
  return record;
}

function hashRecord(record) {
  return crypto.createHash('sha256').update(record).digest('hex');
}

function decodeRecordAt(fd, offset) {
  const header = Buffer.alloc(HEADER_LEN);
  if (fs.readSync(fd, header, 0, HEADER_LEN, offset) < HEADER_LEN) {
    throw new ChainError('truncated block header', offset);
  }
  const len = header.readUInt32LE(0);
  if (len <= 0 || len > MAX_BODY) {
    throw new ChainError('invalid block body length', offset);
  }
  const rest = Buffer.alloc(len + CRC_LEN);
  if (fs.readSync(fd, rest, 0, len + CRC_LEN, offset + HEADER_LEN) < len + CRC_LEN) {
    throw new ChainError('truncated block body', offset);
  }
  const payload = rest.subarray(0, len);
  if (crc32(payload) !== rest.readUInt32LE(len)) {
    throw new ChainError('crc32 mismatch', offset);
  }
  let body;
  try {
    body = JSON.parse(payload.toString('utf8'));
  } catch {
    throw new ChainError('invalid block body json', offset);
  }
  const record = Buffer.concat([header, rest]);
  return {
    record,
    body,
    hash: hashRecord(record),
    nextOffset: offset + record.length,
  };
}

function readIndex(dir) {
  const p = indexPath(dir);
  if (!fs.existsSync(p)) return [];
  const entries = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed) entries.push(JSON.parse(trimmed));
  }
  return entries;
}

function appendIndexEntries(dir, entries) {
  if (entries.length === 0) return;
  fs.appendFileSync(indexPath(dir), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

// Append a block body to the log first, then its index entry. A crash between
// the two writes is exactly the failure recoverChain() repairs.
function appendRecord(dir, record, meta) {
  fs.mkdirSync(dir, { recursive: true });
  const p = logPath(dir);
  const offset = fs.existsSync(p) ? fs.statSync(p).size : 0;
  fs.appendFileSync(p, record);
  appendIndexEntries(dir, [{ seq: meta.seq, offset, length: record.length, hash: meta.hash }]);
  return { offset, length: record.length };
}

// Sequentially decode and validate the log from genesis. Stops at the first
// invalid block; everything from there on stays unavailable.
function scanLog(dir) {
  const batches = [];
  const p = logPath(dir);
  if (!fs.existsSync(p)) return { batches, error: null };
  const fd = fs.openSync(p, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let offset = 0;
    let expectedSeq = 1;
    let prevHash = GENESIS_HASH;
    while (offset < size) {
      let decoded;
      try {
        decoded = decodeRecordAt(fd, offset);
      } catch (err) {
        return { batches, error: { message: err.message, offset } };
      }
      const { body } = decoded;
      if (body.seq !== expectedSeq) {
        return { batches, error: { message: `batch seq mismatch: expected ${expectedSeq}, got ${body.seq}`, offset } };
      }
      if (body.prevHash !== prevHash) {
        return { batches, error: { message: 'prevHash mismatch', offset } };
      }
      batches.push({
        seq: body.seq,
        offset,
        length: decoded.record.length,
        hash: decoded.hash,
        body,
      });
      prevHash = decoded.hash;
      expectedSeq += 1;
      offset = decoded.nextOffset;
    }
    return { batches, error: null };
  } finally {
    fs.closeSync(fd);
  }
}

function verifyChain(dir) {
  const errors = [];
  const { batches, error } = scanLog(dir);
  if (error) {
    errors.push(`log: ${error.message} at offset ${error.offset}`);
  } else {
    const index = readIndex(dir);
    if (index.length !== batches.length) {
      errors.push(`index has ${index.length} entries but log has ${batches.length} valid batches`);
    }
    for (let i = 0; i < Math.min(index.length, batches.length); i += 1) {
      const entry = index[i];
      const batch = batches[i];
      if (
        entry.seq !== batch.seq ||
        entry.offset !== batch.offset ||
        entry.length !== batch.length ||
        entry.hash !== batch.hash
      ) {
        errors.push(`index entry for batch ${entry.seq} does not match the log`);
      }
    }
  }
  return { ok: errors.length === 0, errors, batches };
}

// Admit fully written, valid batches that are missing from the index. If a
// block fails validation, it and every later block stay unavailable; the
// already confirmed prefix (and its budgets) is left untouched.
function recoverChain(dir) {
  const { batches, error } = scanLog(dir);
  const index = readIndex(dir);
  const admitted = [];
  let corrupt = false;

  for (let i = 0; i < index.length; i += 1) {
    const batch = batches[i];
    const entry = index[i];
    if (
      !batch ||
      entry.seq !== batch.seq ||
      entry.offset !== batch.offset ||
      entry.length !== batch.length ||
      entry.hash !== batch.hash
    ) {
      corrupt = true;
      break;
    }
  }

  if (!corrupt && batches.length > index.length) {
    const missing = batches.slice(index.length).map((b) => ({
      seq: b.seq,
      offset: b.offset,
      length: b.length,
      hash: b.hash,
    }));
    appendIndexEntries(dir, missing);
    admitted.push(...missing.map((m) => m.seq));
  }

  if (error) corrupt = true;
  return {
    admitted,
    corrupt,
    validBatches: batches.length,
    indexed: readIndex(dir).length,
    error: error ? error.message : null,
  };
}

function readBatch(dir, seq) {
  const entry = readIndex(dir).find((e) => e.seq === seq);
  if (!entry) throw new ChainError(`batch ${seq} is not indexed`, -1);
  const fd = fs.openSync(logPath(dir), 'r');
  try {
    const decoded = decodeRecordAt(fd, entry.offset);
    if (decoded.hash !== entry.hash || decoded.body.seq !== seq) {
      throw new ChainError(`batch ${seq} does not match its index entry`, entry.offset);
    }
    return decoded;
  } finally {
    fs.closeSync(fd);
  }
}

// Incrementally decode the batch that follows afterSeq, without mutating the
// index. Returns { batch, error }; batch is null when there is no next batch.
function decodeNext(dir, afterSeq) {
  const { batches, error } = scanLog(dir);
  const next = batches.find((b) => b.seq === afterSeq + 1) || null;
  return { batch: next, error: error ? error.message : null };
}

module.exports = {
  GENESIS_HASH,
  ChainError,
  encodeRecord,
  hashRecord,
  decodeRecordAt,
  readIndex,
  appendRecord,
  scanLog,
  verifyChain,
  recoverChain,
  readBatch,
  decodeNext,
  logPath,
  indexPath,
};
