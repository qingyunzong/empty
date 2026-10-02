'use strict';

const fs = require('node:fs');
const fmt = require('./format');

class WxError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'WxError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

// Find the next offset >= `from` that plausibly starts a valid block.
function resync(buf, from) {
  for (let i = from; i + fmt.MIN_BLOCK_LEN <= buf.length; i++) {
    const p = fmt.tryParseBlock(buf, i);
    if (p.status === 'ok' && p.block.crcOk && p.block.footCrcOk) return i;
  }
  return -1;
}

// Parse a whole file buffer. Never throws on damaged content after the magic;
// instead it collects errors/warnings so callers can recover the intact prefix.
function parseBuffer(buf) {
  if (buf.length < fmt.MAGIC.length || !buf.subarray(0, fmt.MAGIC.length).equals(fmt.MAGIC)) {
    throw new WxError('ERR_FORMAT', 'bad or missing file magic');
  }
  const blocks = [];
  const errors = [];   // fatal for verify: ERR_FORMAT / ERR_CHAIN
  const warnings = []; // non-fatal: ERR_CRC (block skipped)
  const indexDiffs = [];
  let offset = fmt.MAGIC.length;
  let index = 0;
  let truncated = false;

  while (offset < buf.length) {
    const p = fmt.tryParseBlock(buf, offset);
    if (p.status === 'ok') {
      const b = p.block;
      b.index = index++;
      if (!b.crcOk) {
        warnings.push({
          code: 'ERR_CRC', index: b.index, id: b.id, offset: b.offset,
          message: `block ${b.id}: payload CRC32C mismatch (stored ${b.crcStored}, computed ${b.crcActual}); block skipped`,
        });
      }
      collectIndexDiffs(b, indexDiffs);
      blocks.push(b);
      offset += b.totalLen;
    } else if (p.status === 'truncated') {
      truncated = true;
      errors.push({
        code: 'ERR_FORMAT', index, offset,
        message: `truncated tail: ${buf.length - offset} byte(s) of an incomplete block at offset ${offset}`,
      });
      break;
    } else {
      const at = resync(buf, offset + 1);
      if (at >= 0) {
        errors.push({
          code: 'ERR_FORMAT', index, offset,
          message: `skipped ${at - offset} unparsable byte(s) at offset ${offset}`,
        });
        offset = at;
      } else {
        errors.push({
          code: 'ERR_FORMAT', index, offset,
          message: `unparsable data at offset ${offset}; cannot resynchronise`,
        });
        break;
      }
    }
  }

  // Global hash chain over block headers. A CRC-damaged payload does not break
  // the chain (the block is skipped); structural tampering does.
  let prevHash = fmt.ZERO_HASH;
  for (const b of blocks) {
    b.prevHashOk = b.prevHash.equals(prevHash);
    if (!b.prevHashOk) {
      errors.push({
        code: 'ERR_CHAIN', index: b.index, id: b.id, offset: b.offset,
        message: `block ${b.id}: hash chain broken (prevHash does not match hash of previous block)`,
      });
    }
    prevHash = b.hash;
  }

  return { blocks, errors, warnings, indexDiffs, truncated };
}

function collectIndexDiffs(b, indexDiffs) {
  if (!b.footCrcOk) {
    indexDiffs.push({ index: b.index, id: b.id, field: 'footnote', expected: 'valid CRC32C', actual: 'mismatch' });
    return; // contents untrustworthy; rebuilt index is authoritative
  }
  const checks = [
    ['id', b.foot.id, b.id],
    ['offset', b.foot.offset, b.offset],
    ['totalLen', b.foot.totalLen, b.totalLen],
    ['type', b.foot.type, b.type],
    ['targetId', b.foot.targetId, b.targetId],
    ['timestamp', b.foot.timestamp, b.timestamp],
    ['payloadLen', b.foot.payloadLen, b.payloadLen],
  ];
  for (const [field, actual, expected] of checks) {
    if (actual !== expected) {
      indexDiffs.push({ index: b.index, id: b.id, field, expected, actual });
    }
  }
}

function readFileBuffer(file, { mustExist = true } = {}) {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    if (err.code === 'ENOENT' && !mustExist) return null;
    if (err.code === 'ENOENT') throw new WxError('ERR_FORMAT', `file not found: ${file}`);
    throw err;
  }
}

function parseFile(file) {
  const buf = readFileBuffer(file);
  return parseBuffer(buf);
}

// Parse and require a clean, appendable chain.
function loadChain(file) {
  const parsed = parseFile(file);
  if (parsed.errors.length > 0) {
    const e = parsed.errors[0];
    throw new WxError(e.code, `refusing to modify damaged file: ${e.message}`, e);
  }
  if (parsed.warnings.length > 0) {
    const w = parsed.warnings[0];
    throw new WxError(w.code, `refusing to modify damaged file: ${w.message}`, w);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// View computation
// ---------------------------------------------------------------------------

// Replay the block history (CRC-valid blocks only) and compute the visible
// version of every logical record. Corrections replace their target; UNDO
// blocks revoke a correction, exposing whatever it had replaced.
function computeView(blocks) {
  const valid = blocks.filter((b) => b.crcOk);
  const revoked = new Set(valid.filter((b) => b.type === fmt.TYPE.UNDO).map((b) => b.targetId));
  const rootOf = new Map();
  const parent = new Map();
  const visible = new Map(); // rootId -> block
  for (const b of valid) {
    if (b.type === fmt.TYPE.DATA) {
      rootOf.set(b.id, b.id);
      visible.set(b.id, b);
    } else if (b.type === fmt.TYPE.CORRECT) {
      const root = rootOf.get(b.targetId);
      if (root === undefined) continue; // dangling target: ignored in the view
      rootOf.set(b.id, root);
      parent.set(b.id, b.targetId);
      if (!revoked.has(b.id)) visible.set(root, b);
    }
  }
  return { visible, revoked, parent, rootOf };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function appendBlock(file, { type, targetId = fmt.NONE, timestamp, payload }) {
  let parsed;
  const buf = readFileBuffer(file, { mustExist: false });
  if (buf === null || buf.length === 0) {
    fs.writeFileSync(file, fmt.MAGIC);
    parsed = { blocks: [] };
  } else {
    parsed = loadChain(file);
  }
  const last = parsed.blocks[parsed.blocks.length - 1];
  const id = last ? last.id + 1 : 0;
  const prevHash = last ? last.hash : fmt.ZERO_HASH;
  const offset = last ? last.offset + last.totalLen : fmt.MAGIC.length;
  const record = fmt.encodeBlock({ type, id, targetId, timestamp, payload, prevHash, offset });
  fs.appendFileSync(file, record);
  return { id, offset, length: record.length };
}

function append(file, payload, { timestamp = Date.now() } = {}) {
  payload = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  return appendBlock(file, { type: fmt.TYPE.DATA, timestamp, payload });
}

function correct(file, id, newPayload, { timestamp } = {}) {
  newPayload = Buffer.isBuffer(newPayload) ? newPayload : Buffer.from(String(newPayload), 'utf8');
  const parsed = loadChain(file);
  const target = parsed.blocks.find((b) => b.id === id);
  if (!target || (target.type !== fmt.TYPE.DATA && target.type !== fmt.TYPE.CORRECT)) {
    throw new WxError('ERR_RANGE', `cannot correct block ${id}: no DATA/CORRECT block with that id`, { id });
  }
  const ts = timestamp === undefined ? target.timestamp : timestamp;
  return appendBlock(file, { type: fmt.TYPE.CORRECT, targetId: id, timestamp: ts, payload: newPayload });
}

function undo(file, correctId) {
  const parsed = loadChain(file);
  const target = parsed.blocks.find((b) => b.id === correctId);
  if (!target || target.type !== fmt.TYPE.CORRECT) {
    throw new WxError('ERR_RANGE', `cannot undo ${correctId}: no CORRECT block with that id`, { id: correctId });
  }
  const { revoked } = computeView(parsed.blocks);
  if (revoked.has(correctId)) {
    return { id: correctId, undone: false, alreadyRevoked: true };
  }
  const dependents = parsed.blocks.filter(
    (b) => b.type === fmt.TYPE.CORRECT && b.targetId === correctId && !revoked.has(b.id),
  );
  if (dependents.length > 0) {
    throw new WxError(
      'ERR_CONFLICT',
      `cannot undo correction ${correctId}: correction(s) ${dependents.map((d) => d.id).join(', ')} depend on it`,
      { id: correctId, dependents: dependents.map((d) => d.id) },
    );
  }
  const res = appendBlock(file, {
    type: fmt.TYPE.UNDO, targetId: correctId, timestamp: Date.now(), payload: Buffer.alloc(0),
  });
  return { id: correctId, undone: true, undoBlockId: res.id };
}

function scan(file) {
  const parsed = parseFile(file);
  return {
    file,
    blocks: parsed.blocks.map((b) => ({
      index: b.index,
      id: b.id,
      type: fmt.TYPE_NAME[b.type],
      targetId: b.targetId,
      timestamp: b.timestamp,
      offset: b.offset,
      length: b.totalLen,
      payloadLength: b.payloadLen,
      crcOk: b.crcOk,
      prevHashOk: b.prevHashOk,
    })),
    truncated: parsed.truncated,
    errors: parsed.errors,
    warnings: parsed.warnings,
  };
}

function verify(file) {
  const parsed = parseFile(file);
  const index = parsed.blocks.map((b) => ({
    id: b.id,
    offset: b.offset,
    length: b.totalLen,
    type: fmt.TYPE_NAME[b.type],
    targetId: b.targetId,
    timestamp: b.timestamp,
    payloadLength: b.payloadLen,
  }));
  return {
    file,
    ok: parsed.errors.length === 0,
    blocks: parsed.blocks.length,
    truncated: parsed.truncated,
    errors: parsed.errors,
    warnings: parsed.warnings,
    indexRebuilt: parsed.indexDiffs.length > 0,
    indexDiffs: parsed.indexDiffs,
    index,
  };
}

function decode(file, { start, end } = {}) {
  const lo = start === undefined ? -Infinity : start;
  const hi = end === undefined ? Infinity : end;
  if (!(lo <= hi)) {
    throw new WxError('ERR_RANGE', `invalid time window: start (${lo}) > end (${hi})`, { start: lo, end: hi });
  }
  const parsed = parseFile(file);
  const chainError = parsed.errors.find((e) => e.code === 'ERR_CHAIN');
  if (chainError) throw new WxError('ERR_CHAIN', chainError.message, chainError);
  const { visible } = computeView(parsed.blocks);
  const records = [...visible.values()]
    .filter((b) => b.timestamp >= lo && b.timestamp <= hi)
    .map((b) => ({
      rootId: b.type === fmt.TYPE.DATA ? b.id : rootOfRecord(parsed.blocks, b),
      blockId: b.id,
      type: fmt.TYPE_NAME[b.type],
      timestamp: b.timestamp,
      corrected: b.type === fmt.TYPE.CORRECT,
      payload: b.payload,
    }))
    .sort((a, b) => a.timestamp - b.timestamp || a.rootId - b.rootId);
  return {
    records,
    truncated: parsed.truncated,
    skippedBlocks: parsed.blocks.filter((b) => !b.crcOk).map((b) => b.id),
  };
}

function rootOfRecord(blocks, block) {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  let cur = block;
  const seen = new Set();
  while (cur.type !== fmt.TYPE.DATA) {
    if (seen.has(cur.id)) return cur.id;
    seen.add(cur.id);
    const parent = byId.get(cur.targetId);
    if (!parent) return cur.id;
    cur = parent;
  }
  return cur.id;
}

module.exports = {
  WxError,
  parseBuffer,
  parseFile,
  computeView,
  append,
  correct,
  undo,
  scan,
  verify,
  decode,
};
