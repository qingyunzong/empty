'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAGIC = 'SG01';
const LOG_FILE = 'records.jsonl';
const COMMIT_FILE = 'COMMIT';

class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

function tokenize(text) {
  return String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

// ---- varint / position block codec (reversible, no JSON arrays on disk) ----

function writeVarint(n, out) {
  if (!Number.isSafeInteger(n) || n < 0) throw new StoreError('INTERNAL', 'bad varint input');
  while (n >= 0x80) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
}

function readVarint(buf, state) {
  let result = 0;
  let shift = 1;
  for (;;) {
    if (state.off >= buf.length) throw new StoreError('CORRUPT_SEGMENT', 'truncated varint');
    const b = buf[state.off++];
    result += (b & 0x7f) * shift;
    if ((b & 0x80) === 0) return result;
    shift *= 128;
    if (shift > Number.MAX_SAFE_INTEGER) throw new StoreError('CORRUPT_SEGMENT', 'varint overflow');
  }
}

function encodePositions(positions) {
  const bytes = [];
  writeVarint(positions.length, bytes);
  let prev = 0;
  for (let i = 0; i < positions.length; i++) {
    const delta = i === 0 ? positions[i] : positions[i] - prev;
    writeVarint(delta, bytes);
    prev = positions[i];
  }
  return Buffer.from(bytes);
}

function decodePositions(buf) {
  const state = { off: 0 };
  const count = readVarint(buf, state);
  const positions = [];
  let prev = 0;
  for (let i = 0; i < count; i++) {
    const delta = readVarint(buf, state);
    prev = i === 0 ? delta : prev + delta;
    positions.push(prev);
  }
  if (state.off !== buf.length) {
    throw new StoreError('CORRUPT_SEGMENT', 'trailing bytes in position block');
  }
  return positions;
}

// ---- in-memory index ----

function buildIndex(docs) {
  const index = new Map(); // term -> Map(docId -> positions[])
  for (const [id, rec] of docs) {
    const terms = tokenize(rec.text);
    for (let i = 0; i < terms.length; i++) {
      let postings = index.get(terms[i]);
      if (!postings) {
        postings = new Map();
        index.set(terms[i], postings);
      }
      let list = postings.get(id);
      if (!list) {
        list = [];
        postings.set(id, list);
      }
      list.push(i);
    }
  }
  return index;
}

// Ordered near match: exists p1 < p2 < ... < pk (term i at pi) with
// (pk - p1) - (k - 1) <= slop. Exact phrase is slop = 0.
function findWindows(posLists, slop) {
  const k = posLists.length;
  const results = [];
  const chosen = new Array(k);
  function bt(i, minPos) {
    if (i === k) {
      if ((chosen[k - 1] - chosen[0]) - (k - 1) <= slop) results.push(chosen.slice());
      return;
    }
    for (const p of posLists[i]) {
      if (p <= minPos) continue;
      if (i > 0 && (p - chosen[0]) - i > slop) break; // sorted: no completion can fit
      chosen[i] = p;
      bt(i + 1, p);
    }
  }
  bt(0, -1);
  return results;
}

// ---- segment encode/decode ----

function encodeSegment(state, indexVersion, logOffset) {
  const docs = {};
  for (const [id, rec] of [...state.docs.entries()].sort()) docs[id] = rec;
  const header = {
    indexVersion,
    logOffset,
    docs,
    deleted: [...state.deleted].sort(),
    terms: {},
  };
  const blocks = [];
  let offset = 0;
  const index = buildIndex(state.docs);
  for (const [term, postings] of [...index.entries()].sort()) {
    header.terms[term] = [];
    for (const [docId, positions] of [...postings.entries()].sort()) {
      const block = encodePositions(positions);
      header.terms[term].push({ id: docId, off: offset, len: block.length });
      blocks.push(block);
      offset += block.length;
    }
  }
  const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const head = Buffer.alloc(8);
  head.write(MAGIC, 0, 4, 'ascii');
  head.writeUInt32LE(headerBuf.length, 4);
  return Buffer.concat([head, headerBuf, ...blocks]);
}

function decodeSegment(buf) {
  if (buf.length < 8 || buf.toString('ascii', 0, 4) !== MAGIC) {
    throw new StoreError('CORRUPT_SEGMENT', 'bad segment magic');
  }
  const headerLen = buf.readUInt32LE(4);
  if (8 + headerLen > buf.length) throw new StoreError('CORRUPT_SEGMENT', 'truncated header');
  let header;
  try {
    header = JSON.parse(buf.toString('utf8', 8, 8 + headerLen));
  } catch {
    throw new StoreError('CORRUPT_SEGMENT', 'segment header is not valid JSON');
  }
  const blocks = buf.subarray(8 + headerLen);
  const terms = {};
  let maxEnd = 0;
  for (const [term, entries] of Object.entries(header.terms || {})) {
    terms[term] = {};
    for (const e of entries) {
      if (e.off < 0 || e.len < 0 || e.off + e.len > blocks.length) {
        throw new StoreError('CORRUPT_SEGMENT', 'position block out of range');
      }
      terms[term][e.id] = decodePositions(blocks.subarray(e.off, e.off + e.len));
      if (e.off + e.len > maxEnd) maxEnd = e.off + e.len;
    }
  }
  if (maxEnd !== blocks.length) {
    throw new StoreError('CORRUPT_SEGMENT', 'segment has orphan bytes');
  }
  return { header, terms };
}

// ---- op log ----

function applyOp(state, op) {
  if (!op || typeof op !== 'object') throw new StoreError('CORRUPT_JSON', 'op is not an object');
  if (op.op === 'add') {
    state.docs.set(op.rec.id, op.rec);
    state.deleted.delete(op.rec.id);
  } else if (op.op === 'del') {
    state.deleted.add(op.id);
  } else if (op.op === 'restore') {
    state.deleted.delete(op.id);
  } else {
    throw new StoreError('CORRUPT_JSON', `unknown op: ${op.op}`);
  }
}

function validateRecord(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return 'record must be an object';
  if (typeof rec.id !== 'string' || rec.id.length === 0) return 'id must be a non-empty string';
  if (typeof rec.merchant !== 'string') return 'merchant must be a string';
  if (typeof rec.amount !== 'number' || !Number.isFinite(rec.amount)) return 'amount must be a finite number';
  if (!Array.isArray(rec.tags) || !rec.tags.every((t) => typeof t === 'string')) return 'tags must be an array of strings';
  if (typeof rec.text !== 'string') return 'text must be a string';
  if (typeof rec.status !== 'string') return 'status must be a string';
  return null;
}

function writeFileSyncFsync(file, data) {
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

class Store {
  constructor(dir, state, indexVersion, logOffset) {
    this.dir = dir;
    this.state = state;
    this.indexVersion = indexVersion;
    this.logOffset = logOffset;
    this.logPath = path.join(dir, LOG_FILE);
  }

  static open(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const state = { docs: new Map(), deleted: new Set() };
    let indexVersion = 0;
    let logOffset = 0;
    let currentSegment = null;
    const commitPath = path.join(dir, COMMIT_FILE);
    if (fs.existsSync(commitPath)) {
      let marker;
      try {
        marker = JSON.parse(fs.readFileSync(commitPath, 'utf8'));
      } catch {
        throw new StoreError('CORRUPT_SEGMENT', 'commit marker is not valid JSON');
      }
      const segPath = path.join(dir, marker.segment);
      if (!fs.existsSync(segPath)) {
        throw new StoreError('CORRUPT_SEGMENT', `missing segment ${marker.segment}`);
      }
      const decoded = decodeSegment(fs.readFileSync(segPath));
      indexVersion = decoded.header.indexVersion;
      logOffset = decoded.header.logOffset;
      currentSegment = marker.segment;
      for (const [id, rec] of Object.entries(decoded.header.docs)) state.docs.set(id, rec);
      for (const id of decoded.header.deleted) state.deleted.add(id);
    }
    const logPath = path.join(dir, LOG_FILE);
    let logSize = 0;
    if (fs.existsSync(logPath)) {
      const buf = fs.readFileSync(logPath);
      logSize = buf.length;
      if (logOffset > logSize) throw new StoreError('CORRUPT_SEGMENT', 'logOffset beyond log size');
      const tail = buf.toString('utf8', logOffset);
      for (const line of tail.split('\n')) {
        if (!line.trim()) continue;
        let op;
        try {
          op = JSON.parse(line);
        } catch {
          throw new StoreError('CORRUPT_JSON', 'corrupt JSON line in records log');
        }
        applyOp(state, op);
      }
    }
    // crash recovery: drop temp files and unreferenced segments
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (f.endsWith('.tmp')) fs.rmSync(full, { force: true });
      else if (/^segment-\d+\.bin$/.test(f) && f !== currentSegment) fs.rmSync(full, { force: true });
    }
    return new Store(dir, state, indexVersion, logSize);
  }

  _appendOps(ops) {
    const lines = ops.map((o) => JSON.stringify(o)).join('\n') + '\n';
    const fd = fs.openSync(this.logPath, 'a');
    try {
      fs.writeSync(fd, lines);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    for (const op of ops) applyOp(this.state, op);
    this.logOffset += Buffer.byteLength(lines);
  }

  commit() {
    const version = this.indexVersion + 1;
    const segName = `segment-${version}.bin`;
    const segBuf = encodeSegment(this.state, version, this.logOffset);
    const tmpSeg = path.join(this.dir, `segment-${version}.tmp`);
    writeFileSyncFsync(tmpSeg, segBuf);
    fs.renameSync(tmpSeg, path.join(this.dir, segName));
    const marker = JSON.stringify({ version, segment: segName, logOffset: this.logOffset });
    const tmpCommit = path.join(this.dir, 'COMMIT.tmp');
    writeFileSyncFsync(tmpCommit, marker);
    fs.renameSync(tmpCommit, path.join(this.dir, COMMIT_FILE));
    for (const f of fs.readdirSync(this.dir)) {
      if (/^segment-\d+\.bin$/.test(f) && f !== segName) fs.rmSync(path.join(this.dir, f), { force: true });
    }
    this.indexVersion = version;
    return version;
  }

  addRecords(records) {
    if (!Array.isArray(records) || records.length === 0) {
      throw new StoreError('INVALID_RECORD', 'expected a non-empty array of records');
    }
    const seen = new Set();
    for (const rec of records) {
      const err = validateRecord(rec);
      if (err) throw new StoreError('INVALID_RECORD', `${err} (id=${rec && rec.id})`);
      if (seen.has(rec.id) || this.state.docs.has(rec.id)) {
        throw new StoreError('DUPLICATE_ID', `duplicate id: ${rec.id}`);
      }
      seen.add(rec.id);
    }
    this._appendOps(records.map((rec) => ({ op: 'add', rec })));
    this.commit();
    return records.length;
  }

  delete(id) {
    if (!this.state.docs.has(id)) throw new StoreError('UNKNOWN_ID', `unknown id: ${id}`);
    if (this.state.deleted.has(id)) return false;
    this._appendOps([{ op: 'del', id }]);
    this.commit();
    return true;
  }

  restore(id) {
    if (!this.state.docs.has(id)) throw new StoreError('UNKNOWN_ID', `unknown id: ${id}`);
    if (!this.state.deleted.has(id)) return false;
    this._appendOps([{ op: 'restore', id }]);
    this.commit();
    return true;
  }

  isLive(id) {
    return this.state.docs.has(id) && !this.state.deleted.has(id);
  }

  query(phrase, opts = {}) {
    const slop = opts.slop === undefined ? 0 : opts.slop;
    if (!Number.isInteger(slop) || slop < 0) {
      throw new StoreError('INVALID_SLOP', `invalid slop: ${opts.slop}`);
    }
    const terms = tokenize(phrase);
    if (terms.length === 0) throw new StoreError('INVALID_QUERY', 'phrase contains no terms');
    const index = buildIndex(this.state.docs);
    const hits = [];
    for (const [id, rec] of [...this.state.docs.entries()].sort()) {
      if (this.state.deleted.has(id)) continue;
      const posLists = terms.map((t) => {
        const postings = index.get(t);
        return postings ? postings.get(id) : undefined;
      });
      if (posLists.some((p) => !p)) continue;
      const windows = findWindows(posLists, slop);
      if (windows.length > 0) {
        hits.push({
          id,
          merchant: rec.merchant,
          amount: rec.amount,
          tags: rec.tags,
          status: rec.status,
          text: rec.text,
          positions: windows,
        });
      }
    }
    const live = [...this.state.docs.entries()]
      .filter(([id]) => !this.state.deleted.has(id))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([, rec]) => rec);
    const liveSha256 = crypto.createHash('sha256').update(stableStringify(live), 'utf8').digest('hex');
    return {
      hits,
      certificate: {
        indexVersion: this.indexVersion,
        query: { phrase, slop, terms },
        liveCount: live.length,
        liveSha256,
      },
    };
  }

  decodeCurrentSegment() {
    const commitPath = path.join(this.dir, COMMIT_FILE);
    if (!fs.existsSync(commitPath)) return null;
    const marker = JSON.parse(fs.readFileSync(commitPath, 'utf8'));
    const decoded = decodeSegment(fs.readFileSync(path.join(this.dir, marker.segment)));
    return { indexVersion: decoded.header.indexVersion, terms: decoded.terms };
  }
}

module.exports = {
  Store,
  StoreError,
  tokenize,
  stableStringify,
  encodePositions,
  decodePositions,
  encodeSegment,
  decodeSegment,
  findWindows,
  buildIndex,
};
