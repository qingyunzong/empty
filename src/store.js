import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tokenize } from './text.js';
import { encodePositions, decodePositions } from './varint.js';

export class IndexError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IndexError';
    this.code = code;
  }
}

const ZERO_HASH = '0'.repeat(64);
const MERGE_THRESHOLD = 3;

export function canon(value) {
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canon(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function emptyState() {
  return { head: 0, nextSeg: 1, docs: new Set(), tombstones: new Set(), segments: [] };
}

export function logicalIndex(state) {
  const out = {};
  for (const seg of state.segments) {
    for (const [term, docs] of Object.entries(seg.postings)) {
      for (const [doc, positions] of Object.entries(docs)) {
        if (state.tombstones.has(doc)) continue;
        (out[term] ??= {})[doc] = positions;
      }
    }
  }
  return out;
}

// Hash is over the logical index only: independent of physical segment layout,
// so incremental merges never change it.
export function indexHash(state) {
  return sha256(canon({
    docs: [...state.docs].sort(),
    tombstones: [...state.tombstones].sort(),
    index: logicalIndex(state),
  }));
}

const stateFile = (dir) => path.join(dir, 'state.json');
const logFile = (dir) => path.join(dir, 'batches.log');
const segDir = (dir) => path.join(dir, 'segments');

function writeAtomic(file, content) {
  const tmp = file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

export function loadState(dir) {
  if (!fs.existsSync(stateFile(dir))) return emptyState();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(stateFile(dir), 'utf8'));
  } catch {
    throw new IndexError('E_CORRUPT', 'state.json is not valid JSON');
  }
  const state = emptyState();
  state.head = raw.head;
  state.nextSeg = raw.nextSeg;
  state.docs = new Set(raw.docs);
  state.tombstones = new Set(raw.tombstones);
  state.storedHash = raw.indexHash;
  for (const meta of raw.segments) {
    const file = path.join(segDir(dir), meta.file);
    let segRaw;
    try {
      segRaw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new IndexError('E_CORRUPT', `segment ${meta.file} unreadable`);
    }
    const postings = {};
    for (const [term, docs] of Object.entries(segRaw.postings)) {
      postings[term] = {};
      for (const [doc, b64] of Object.entries(docs)) {
        try {
          postings[term][doc] = decodePositions(Buffer.from(b64, 'base64'));
        } catch {
          throw new IndexError('E_CORRUPT', `segment ${meta.file}: varint decode failed for ${term}/${doc}`);
        }
      }
    }
    state.segments.push({ id: segRaw.id, postings });
  }
  return state;
}

export function saveState(dir, state) {
  // Incremental merge: tombstoned docs are physically dropped so deleted
  // phrases can never resurrect. Tombstone set itself is retained so the
  // logical hash stays stable across merges and replays.
  if (state.segments.length >= MERGE_THRESHOLD) {
    const merged = {};
    for (const seg of state.segments) {
      for (const [term, docs] of Object.entries(seg.postings)) {
        for (const [doc, positions] of Object.entries(docs)) {
          if (state.tombstones.has(doc)) continue;
          (merged[term] ??= {})[doc] = positions;
        }
      }
    }
    state.segments = [{ id: state.nextSeg++, postings: merged }];
  }
  fs.mkdirSync(segDir(dir), { recursive: true });
  const wanted = new Set();
  for (const seg of state.segments) {
    const file = `seg-${seg.id}.json`;
    wanted.add(file);
    const ser = {};
    for (const [term, docs] of Object.entries(seg.postings)) {
      ser[term] = {};
      for (const [doc, positions] of Object.entries(docs)) {
        ser[term][doc] = encodePositions(positions).toString('base64');
      }
    }
    writeAtomic(path.join(segDir(dir), file), JSON.stringify({ id: seg.id, postings: ser }));
  }
  for (const f of fs.readdirSync(segDir(dir))) {
    if (!wanted.has(f)) fs.unlinkSync(path.join(segDir(dir), f));
  }
  const raw = {
    head: state.head,
    nextSeg: state.nextSeg,
    docs: [...state.docs].sort(),
    tombstones: [...state.tombstones].sort(),
    segments: state.segments.map((s) => ({ id: s.id, file: `seg-${s.id}.json` })),
    indexHash: indexHash(state),
  };
  writeAtomic(stateFile(dir), JSON.stringify(raw, null, 2));
}

export function readLog(dir) {
  if (!fs.existsSync(logFile(dir))) return [];
  const lines = fs.readFileSync(logFile(dir), 'utf8').split('\n').filter((l) => l.length > 0);
  const entries = [];
  let prev = ZERO_HASH;
  lines.forEach((line, i) => {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      throw new IndexError('E_CORRUPT', `log line ${i + 1} is not valid JSON`);
    }
    if (e.seq !== i + 1 || e.prev !== prev || !Array.isArray(e.ops)) {
      throw new IndexError('E_CORRUPT', `log line ${i + 1}: chain broken`);
    }
    if (sha256(canon({ seq: e.seq, prev: e.prev, ops: e.ops })) !== e.hash) {
      throw new IndexError('E_CORRUPT', `log line ${i + 1}: hash mismatch`);
    }
    entries.push(e);
    prev = e.hash;
  });
  return entries;
}

export function appendLog(dir, ops) {
  const entries = readLog(dir);
  const seq = entries.length + 1;
  const prev = entries.length ? entries[entries.length - 1].hash : ZERO_HASH;
  const hash = sha256(canon({ seq, prev, ops }));
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(logFile(dir), JSON.stringify({ seq, prev, ops, hash }) + '\n');
  return { seq, hash };
}

function removeDoc(state, id) {
  for (const seg of state.segments) {
    for (const docs of Object.values(seg.postings)) delete docs[id];
  }
}

export function applyOps(state, ops) {
  const batchPostings = {};
  let hasAdd = false;
  for (const op of ops) {
    if (op.op === 'add') {
      hasAdd = true;
      removeDoc(state, op.id); // re-add of a work order replaces the old version
      state.tombstones.delete(op.id);
      state.docs.add(op.id);
      const positionsByTerm = {};
      tokenize(op.text).forEach((tok, i) => {
        (positionsByTerm[tok] ??= []).push(i);
      });
      for (const [term, positions] of Object.entries(positionsByTerm)) {
        (batchPostings[term] ??= {})[op.id] = positions;
      }
    } else if (op.op === 'del') {
      state.docs.delete(op.id);
      state.tombstones.add(op.id);
    }
  }
  if (hasAdd) state.segments.push({ id: state.nextSeg++, postings: batchPostings });
  state.head += 1;
  return state;
}

export function rebuild(entries) {
  const state = emptyState();
  for (const e of entries) applyOps(state, e.ops);
  return state;
}

export function undoTo(dir, to) {
  const entries = readLog(dir); // throws E_CORRUPT on tampering
  const head = entries.length;
  const target = to === undefined ? head - 1 : to;
  if (!Number.isInteger(target) || target < 0 || target >= head) {
    throw new IndexError('E_UNDO', `cannot undo to batch ${to} (head=${head})`);
  }
  const state = rebuild(entries.slice(0, target));
  saveState(dir, state);
  const kept = entries.slice(0, target).map((e) => JSON.stringify(e)).join('\n');
  writeAtomic(logFile(dir), kept + (kept ? '\n' : ''));
  return state;
}

export function verify(dir) {
  const entries = readLog(dir); // hash-chain check
  const state = loadState(dir); // varint decode check
  if (state.head !== entries.length) {
    throw new IndexError('E_CORRUPT', `head ${state.head} != log batches ${entries.length}`);
  }
  const actual = indexHash(state);
  if (state.storedHash !== undefined && state.storedHash !== actual) {
    throw new IndexError('E_CORRUPT', 'state.json indexHash does not match segment contents');
  }
  const replayed = rebuild(entries);
  if (indexHash(replayed) !== actual) {
    throw new IndexError('E_CORRUPT', 'replay hash != stored index hash');
  }
  return { hash: indexHash(state), batches: entries.length };
}

export function compareIds(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function phraseHits(index, tokens) {
  const out = new Map();
  const first = index[tokens[0]];
  if (!first) return out;
  for (const [doc, positions] of Object.entries(first)) {
    const lists = tokens.map((t) => index[t]?.[doc]);
    if (lists.some((l) => !l)) continue;
    const sets = lists.map((l) => new Set(l));
    const hits = [];
    for (const p of positions) {
      let ok = true;
      for (let i = 1; i < tokens.length; i++) {
        if (!sets[i].has(p + i)) { ok = false; break; }
      }
      if (ok) hits.push(p);
    }
    if (hits.length) out.set(doc, hits);
  }
  return out;
}

function nearHits(index, t1, t2, k) {
  const out = new Map();
  const d1 = index[t1];
  if (!d1) return out;
  const d2 = index[t2] ?? {};
  for (const [doc, p1s] of Object.entries(d1)) {
    const p2s = d2[doc];
    if (!p2s) continue;
    const hits = [];
    for (const a of p1s) for (const b of p2s) {
      if (Math.abs(a - b) <= k) hits.push([a, b]);
    }
    if (hits.length) out.set(doc, hits);
  }
  return out;
}

export function runQuery(state, q) {
  if (typeof q !== 'string' || q.trim() === '') {
    throw new IndexError('E_PARSE', 'empty query');
  }
  const parts = q.trim().split(/\s+/);
  const nearIdx = parts.findIndex((p) => /^NEAR\/\d+$/i.test(p));
  let hits;
  if (nearIdx !== -1) {
    if (parts.length !== 3 || nearIdx !== 1) {
      throw new IndexError('E_PARSE', 'NEAR query must be: term NEAR/k term');
    }
    const k = parseInt(parts[1].split('/')[1], 10);
    const t1 = tokenize(parts[0]);
    const t2 = tokenize(parts[2]);
    if (t1.length !== 1 || t2.length !== 1) {
      throw new IndexError('E_PARSE', 'NEAR operands must be single terms');
    }
    hits = nearHits(logicalIndex(state), t1[0], t2[0], k);
  } else {
    const tokens = tokenize(q);
    if (tokens.length === 0) throw new IndexError('E_PARSE', 'no searchable terms');
    hits = phraseHits(logicalIndex(state), tokens);
  }
  return [...hits.entries()]
    .map(([id, h]) => ({ id, hits: h }))
    .sort((a, b) => b.hits.length - a.hits.length || compareIds(a.id, b.id));
}
