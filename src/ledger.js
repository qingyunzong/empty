'use strict';

const fs = require('node:fs');
const { crc32 } = require('./crc32');
const fmt = require('./format');

class LedgerError extends Error {
  constructor(code, message, block = null) {
    super(message);
    this.code = code;
    this.block = block;
  }
}

function initialState() {
  return { balance: 0, frozen: 0, txs: {} };
}

function withAvailable(state) {
  return {
    balance: state.balance,
    frozen: state.frozen,
    available: state.balance - state.frozen,
    txs: state.txs,
  };
}

function reject(code, message) {
  return { ok: false, code, message };
}

// Pure state transition. Mutates `state` only on success.
function applyEvent(state, ev) {
  switch (ev.type) {
    case 'append': {
      if (state.txs[ev.txId]) return reject('DUPLICATE_TX', `tx ${ev.txId} already exists`);
      if (ev.kind === 'credit') state.balance += ev.amount;
      else state.balance -= ev.amount;
      state.txs[ev.txId] = { kind: ev.kind, amount: ev.amount, status: 'active' };
      return { ok: true };
    }
    case 'settle': {
      const available = state.balance - state.frozen;
      if (ev.amount > available) {
        return reject('INSUFFICIENT_FUNDS', `settle ${ev.amount} exceeds available ${available}`);
      }
      state.balance -= ev.amount;
      return { ok: true };
    }
    case 'cancel': {
      const tx = state.txs[ev.txId];
      if (!tx) return reject('TX_NOT_FOUND', `tx ${ev.txId} does not exist`);
      if (tx.status === 'cancelled') return reject('ALREADY_CANCELLED', `tx ${ev.txId} already cancelled`);
      if (tx.status === 'frozen') return reject('FROZEN_CONFLICT', `tx ${ev.txId} is frozen`);
      if (tx.kind === 'credit') state.balance -= tx.amount;
      else state.balance += tx.amount;
      tx.status = 'cancelled';
      return { ok: true };
    }
    case 'freeze': {
      const tx = state.txs[ev.txId];
      if (!tx) return reject('TX_NOT_FOUND', `tx ${ev.txId} does not exist`);
      if (tx.status === 'frozen') return reject('ALREADY_FROZEN', `tx ${ev.txId} already frozen`);
      if (tx.status === 'cancelled') return reject('ALREADY_CANCELLED', `tx ${ev.txId} already cancelled`);
      state.frozen += tx.amount;
      tx.status = 'frozen';
      return { ok: true };
    }
    default:
      return reject('UNKNOWN_EVENT', `unknown event type ${ev.type}`);
  }
}

function readIndex(path) {
  if (!fs.existsSync(path)) return null;
  const size = fs.statSync(path).size;
  if (size < fmt.FOOTER_LEN) return null;
  const fd = fs.openSync(path, 'r');
  try {
    const footer = Buffer.alloc(fmt.FOOTER_LEN);
    fs.readSync(fd, footer, 0, fmt.FOOTER_LEN, size - fmt.FOOTER_LEN);
    if (!footer.subarray(0, 4).equals(fmt.FOOTER_MAGIC)) return null;
    const indexLen = footer.readUInt32LE(4);
    if (indexLen < fmt.INDEX_FIXED_LEN || indexLen + fmt.FOOTER_LEN > size) {
      throw new LedgerError('CORRUPT_INDEX', 'index length out of range');
    }
    const indexOffset = size - fmt.FOOTER_LEN - indexLen;
    const raw = Buffer.alloc(indexLen);
    fs.readSync(fd, raw, 0, indexLen, indexOffset);
    const entries = fmt.tryParseIndexAt(Buffer.concat([raw, footer]), 0);
    if (!entries) throw new LedgerError('CORRUPT_INDEX', 'index checksum or layout invalid');
    return { entries, indexOffset, indexLen, raw };
  } finally {
    fs.closeSync(fd);
  }
}

function readBlockAt(fd, offset) {
  const header = Buffer.alloc(fmt.HEADER_LEN);
  const n = fs.readSync(fd, header, 0, fmt.HEADER_LEN, offset);
  if (n < fmt.HEADER_LEN) throw new LedgerError('CORRUPT_BLOCK', 'truncated block header');
  const payloadLen = header.readUInt32LE(20);
  const blockLen = header.readUInt32LE(16);
  if (blockLen !== fmt.MIN_BLOCK_LEN + payloadLen) {
    throw new LedgerError('CORRUPT_BLOCK', 'block length mismatch');
  }
  const buf = Buffer.alloc(blockLen);
  header.copy(buf, 0);
  const m = fs.readSync(fd, buf, fmt.HEADER_LEN, blockLen - fmt.HEADER_LEN, offset + fmt.HEADER_LEN);
  if (m < blockLen - fmt.HEADER_LEN) throw new LedgerError('CORRUPT_BLOCK', 'truncated block body');
  return { block: fmt.decodeBlock(buf, 0), raw: buf };
}

function dataEnd(entries) {
  return entries.length === 0 ? 0 : entries[entries.length - 1].offset + entries[entries.length - 1].length;
}

// Decode state by seeking through the index; never scans the file.
// fromSeq lets decoding start at any index-recorded block.
function decodeState(path, { fromSeq = 0 } = {}) {
  const idx = readIndex(path);
  if (!idx) {
    if (fs.existsSync(path) && fs.statSync(path).size > 0) {
      throw new LedgerError('NO_INDEX', 'index missing; run verify --rebuild');
    }
    return { state: initialState(), entries: [], blocks: 0 };
  }
  if (fromSeq > idx.entries.length) {
    throw new LedgerError('BAD_RANGE', `fromSeq ${fromSeq} beyond block count ${idx.entries.length}`);
  }
  const state = initialState();
  const fd = fs.openSync(path, 'r');
  try {
    let offset = fromSeq < idx.entries.length ? idx.entries[fromSeq].offset : 0;
    for (let i = fromSeq; i < idx.entries.length; i++) {
      if (offset !== idx.entries[i].offset) {
        throw new LedgerError('CORRUPT_INDEX', `index offset mismatch at block ${i}`, i);
      }
      const { block, raw } = readBlockAt(fd, offset);
      if (block.seq !== i) throw new LedgerError('CORRUPT_BLOCK', `bad seq at block ${i}`, i);
      const ev = JSON.parse(block.payload.toString('utf8'));
      const res = applyEvent(state, ev);
      if (!res.ok) throw new LedgerError('REPLAY_FAILED', `replay failed at block ${i}: ${res.message}`, i);
      offset += raw.length;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { state, entries: idx.entries, blocks: idx.entries.length };
}

// Append one event after validating it against current state.
// opts.crashAfterBlockWrite simulates the crash point: block written+fsynced, index not updated.
function appendEvent(path, event, opts = {}) {
  const { state, entries } = decodeState(path);
  const res = applyEvent(state, event);
  if (!res.ok) {
    return { ok: false, error: { code: res.code, block: null, message: res.message } };
  }
  const size = fs.existsSync(path) ? fs.statSync(path).size : 0;
  const end = dataEnd(entries);
  if (size > 0 && entries.length === 0) {
    throw new LedgerError('NO_INDEX', 'data without index; run verify --rebuild');
  }
  const idx = readIndex(path);
  const expectedSize = idx ? end + idx.indexLen + fmt.FOOTER_LEN : 0;
  if (size !== expectedSize) {
    throw new LedgerError('STALE_INDEX', 'orphan bytes beyond index; run verify --rebuild');
  }

  const fd = fs.openSync(path, fs.existsSync(path) ? 'r+' : 'w');
  try {
    let prevCrc = 0;
    if (entries.length > 0) {
      prevCrc = crc32(readBlockAt(fd, entries[entries.length - 1].offset).raw);
    }
    const payload = Buffer.from(JSON.stringify(event), 'utf8');
    const block = fmt.encodeBlock({ seq: entries.length, startOffset: end, prevCrc, payload });
    fs.writeSync(fd, block, 0, block.length, end);
    fs.fsyncSync(fd);
    // ---- crash point: block durable, index not yet updated ----
    if (opts.crashAfterBlockWrite || process.env.LEDGER_CRASH_AFTER_BLOCK === '1') {
      return { ok: true, crashed: true, state: withAvailable(state) };
    }
    const newEntries = entries.concat([{ offset: end, length: block.length }]);
    const indexBuf = fmt.encodeIndex(newEntries);
    fs.writeSync(fd, indexBuf, 0, indexBuf.length, end + block.length);
    const footer = fmt.encodeFooter(indexBuf.length);
    fs.writeSync(fd, footer, 0, footer.length, end + block.length + indexBuf.length);
    fs.fsyncSync(fd);
    return { ok: true, state: withAvailable(state), block: entries.length };
  } finally {
    fs.closeSync(fd);
  }
}

// Validate every block reachable through the index, plus the checksum chain.
function verify(path) {
  const idx = readIndex(path);
  if (!idx) throw new LedgerError('NO_INDEX', 'index missing or unreadable');
  const fd = fs.openSync(path, 'r');
  try {
    let prevCrc = 0;
    for (let i = 0; i < idx.entries.length; i++) {
      let block, raw;
      try {
        ({ block, raw } = readBlockAt(fd, idx.entries[i].offset));
      } catch (e) {
        throw new LedgerError('CORRUPT_BLOCK', `block ${i}: ${e.message}`, i);
      }
      if (block.seq !== i) throw new LedgerError('CORRUPT_BLOCK', `block ${i}: bad seq ${block.seq}`, i);
      if (block.startOffset !== idx.entries[i].offset) {
        throw new LedgerError('CORRUPT_BLOCK', `block ${i}: bad start offset`, i);
      }
      if (block.blockLen !== idx.entries[i].length) {
        throw new LedgerError('CORRUPT_BLOCK', `block ${i}: bad length`, i);
      }
      if (block.prevCrc !== prevCrc) {
        throw new LedgerError('CORRUPT_BLOCK', `block ${i}: prev checksum mismatch`, i);
      }
      prevCrc = crc32(raw);
    }
    return { ok: true, blocks: idx.entries.length };
  } finally {
    fs.closeSync(fd);
  }
}

// Sequentially scan blocks from offset 0, rebuild the index, and truncate
// anything past the last good block (stale index or corrupt tail).
// A valid footer whose index starts before the cursor means the last block
// was written over the old index (the defined crash point): treat the
// remaining bytes as a torn index remnant, not corruption.
function isIndexRemnant(buf, cursor) {
  if (buf.length - cursor < fmt.FOOTER_LEN) return false;
  const footer = buf.subarray(buf.length - fmt.FOOTER_LEN);
  if (!footer.subarray(0, 4).equals(fmt.FOOTER_MAGIC)) return false;
  const indexStart = buf.length - fmt.FOOTER_LEN - footer.readUInt32LE(4);
  return indexStart < cursor;
}

function rebuild(path) {
  if (!fs.existsSync(path)) throw new LedgerError('NO_FILE', 'ledger file does not exist');
  const buf = fs.readFileSync(path);
  const entries = [];
  let cursor = 0;
  let prevCrc = 0;
  let badBlock = null;
  let badReason = null;
  for (;;) {
    if (cursor === buf.length) break;
    const stale = fmt.tryParseIndexAt(buf, cursor);
    if (stale) break; // crash recovery: orphan block(s) followed by stale index
    if (isIndexRemnant(buf, cursor)) break; // crash recovery: torn old index
    try {
      const block = fmt.decodeBlock(buf, cursor);
      const seq = entries.length;
      if (block.seq !== seq) throw Object.assign(new Error(`bad seq ${block.seq}`), {});
      if (block.startOffset !== cursor) throw new Error('bad start offset');
      if (block.prevCrc !== prevCrc) throw new Error('prev checksum mismatch');
      prevCrc = crc32(buf.subarray(cursor, cursor + block.blockLen));
      entries.push({ offset: cursor, length: block.blockLen });
      cursor += block.blockLen;
    } catch (e) {
      badBlock = entries.length;
      badReason = e.message;
      break;
    }
  }
  const indexBuf = fmt.encodeIndex(entries);
  const footer = fmt.encodeFooter(indexBuf.length);
  const fd = fs.openSync(path, 'r+');
  try {
    fs.ftruncateSync(fd, cursor);
    fs.writeSync(fd, indexBuf, 0, indexBuf.length, cursor);
    fs.writeSync(fd, footer, 0, footer.length, cursor + indexBuf.length);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (badBlock !== null) {
    return {
      ok: false,
      error: { code: 'CORRUPT_BLOCK', block: badBlock, message: `block ${badBlock}: ${badReason}` },
      blocks: entries.length,
    };
  }
  return { ok: true, blocks: entries.length, entries };
}

module.exports = {
  LedgerError,
  initialState,
  withAvailable,
  applyEvent,
  readIndex,
  decodeState,
  appendEvent,
  verify,
  rebuild,
  dataEnd,
};
