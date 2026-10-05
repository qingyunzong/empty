import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { encodePositions, decodePositions } from './codec.js';
import { tokenize } from './tokenize.js';

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

export const INDEX_FILE = 'index.json';
export const TMP_FILE = 'index.json.tmp';
export const COMMIT_FILE = 'commit.json';
export const TOMBSTONE_FILE = 'tombstones.json';

const MAX_SLOP = 100;

function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function validateRecord(rec, ordinal) {
  const where = ordinal == null ? '' : ` (record ${ordinal})`;
  const bad = (msg) => new StoreError('INVALID_RECORD', msg + where);
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) throw bad('record must be an object');
  const { id, merchant, amount, tags, text, status } = rec;
  if (id === undefined || id === null || String(id) === '') throw bad('missing or empty id');
  if (typeof merchant !== 'string') throw bad('merchant must be a string');
  if (typeof amount !== 'number' || !Number.isFinite(amount)) throw bad('amount must be a finite number');
  if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string')) throw bad('tags must be a string array');
  if (typeof text !== 'string') throw bad('text must be a string');
  if (typeof status !== 'string') throw bad('status must be a string');
  return { id: String(id), merchant, amount, tags: [...tags], text, status };
}

function buildPostings(docs) {
  const postings = new Map(); // term -> Map(docId -> positions[])
  for (const [id, doc] of docs) {
    const seen = new Map();
    tokenize(doc.text).forEach((term, i) => {
      if (!seen.has(term)) seen.set(term, []);
      seen.get(term).push(i);
    });
    for (const [term, positions] of seen) {
      if (!postings.has(term)) postings.set(term, new Map());
      postings.get(term).set(id, positions);
    }
  }
  return postings;
}

function serializePostings(postings) {
  const out = {};
  for (const [term, docMap] of [...postings.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    out[term] = {};
    for (const [id, positions] of [...docMap.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      out[term][id] = encodePositions(positions).toString('base64');
    }
  }
  return out;
}

// Crash recovery: a commit marker means the temp segment was fully written and
// intended to go live, so complete the atomic replace. A temp segment without a
// commit marker was never committed, so discard it and keep the old index.
function recoverDir(dir) {
  const tmpPath = path.join(dir, TMP_FILE);
  const commitPath = path.join(dir, COMMIT_FILE);
  if (fs.existsSync(commitPath)) {
    if (fs.existsSync(tmpPath)) fs.renameSync(tmpPath, path.join(dir, INDEX_FILE));
    fs.unlinkSync(commitPath);
  } else if (fs.existsSync(tmpPath)) {
    fs.unlinkSync(tmpPath);
  }
}

function writeFileSyncFsync(filePath, data) {
  const fd = fs.openSync(filePath, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Commit protocol: temp segment -> commit marker -> atomic rename -> clear marker.
function persistIndex(dir, data) {
  const tmpPath = path.join(dir, TMP_FILE);
  const commitPath = path.join(dir, COMMIT_FILE);
  writeFileSyncFsync(tmpPath, JSON.stringify(data));
  writeFileSyncFsync(commitPath, JSON.stringify({ tmp: TMP_FILE, target: INDEX_FILE, version: data.version }));
  fs.renameSync(tmpPath, path.join(dir, INDEX_FILE));
  fs.unlinkSync(commitPath);
}

function persistTombstones(dir, revoked) {
  const tmpPath = path.join(dir, TOMBSTONE_FILE + '.tmp');
  writeFileSyncFsync(tmpPath, JSON.stringify({ revoked: [...revoked].sort() }));
  fs.renameSync(tmpPath, path.join(dir, TOMBSTONE_FILE));
}

function findAlignments(lists, slop) {
  const results = [];
  const chosen = [];
  (function rec(i, prevPos, slack) {
    if (i === lists.length) {
      results.push([...chosen]);
      return;
    }
    for (const pos of lists[i]) {
      if (i === 0) {
        chosen.push(pos);
        rec(1, pos, 0);
        chosen.pop();
      } else if (pos > prevPos) {
        const next = slack + (pos - prevPos - 1);
        if (next > slop) break; // lists are sorted ascending
        chosen.push(pos);
        rec(i + 1, pos, next);
        chosen.pop();
      }
    }
  })(0, -1, 0);
  return results;
}

export class VoucherStore {
  constructor(dir, data, revoked) {
    this.dir = dir;
    this.version = data.version;
    this.docs = new Map(Object.entries(data.docs));
    this.postings = data.postings; // term -> { docId: base64 compressed block }
    this.revoked = revoked; // Set of tombstoned ids
  }

  static build(dir, records) {
    const valid = records.map((r, i) => validateRecord(r, i + 1));
    fs.mkdirSync(dir, { recursive: true });
    recoverDir(dir);
    const docs = new Map(valid.map((r) => [r.id, r]));
    const data = {
      version: 1,
      docs: Object.fromEntries([...docs.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
      postings: serializePostings(buildPostings(docs)),
    };
    persistIndex(dir, data);
    persistTombstones(dir, new Set());
    return new VoucherStore(dir, data, new Set());
  }

  static open(dir) {
    recoverDir(dir);
    const indexPath = path.join(dir, INDEX_FILE);
    if (!fs.existsSync(indexPath)) throw new StoreError('NO_INDEX', `no index found in ${dir}`);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    } catch {
      throw new StoreError('CORRUPT_JSON', `cannot parse ${INDEX_FILE}`);
    }
    if (typeof data?.version !== 'number' || typeof data?.docs !== 'object' || typeof data?.postings !== 'object') {
      throw new StoreError('CORRUPT_JSON', `${INDEX_FILE} has an invalid shape`);
    }
    let revoked = new Set();
    const tombPath = path.join(dir, TOMBSTONE_FILE);
    if (fs.existsSync(tombPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(tombPath, 'utf8'));
        revoked = new Set(Array.isArray(parsed.revoked) ? parsed.revoked.map(String) : []);
      } catch {
        throw new StoreError('CORRUPT_JSON', `cannot parse ${TOMBSTONE_FILE}`);
      }
    }
    return new VoucherStore(dir, data, revoked);
  }

  addRecords(records) {
    const valid = records.map((r, i) => validateRecord(r, i + 1));
    for (const r of valid) this.docs.set(r.id, r);
    const data = {
      version: this.version + 1,
      docs: Object.fromEntries([...this.docs.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
      postings: serializePostings(buildPostings(this.docs)),
    };
    persistIndex(this.dir, data);
    this.version = data.version;
    this.postings = data.postings;
    return this.version;
  }

  revoke(id) {
    const key = String(id);
    if (!this.docs.has(key)) throw new StoreError('UNKNOWN_ID', `unknown id: ${key}`);
    this.revoked.add(key);
    persistTombstones(this.dir, this.revoked);
  }

  restore(id) {
    const key = String(id);
    if (!this.docs.has(key)) throw new StoreError('UNKNOWN_ID', `unknown id: ${key}`);
    this.revoked.delete(key);
    persistTombstones(this.dir, this.revoked);
  }

  isLive(id) {
    return this.docs.has(id) && !this.revoked.has(id);
  }

  liveRecords() {
    return [...this.docs.values()]
      .filter((doc) => !this.revoked.has(doc.id))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  positionsFor(term, id) {
    const block = this.postings[term]?.[id];
    return block === undefined ? null : decodePositions(Buffer.from(block, 'base64'));
  }

  certificate(query) {
    const liveRecordsSha256 = crypto.createHash('sha256')
      .update(stableStringify(this.liveRecords()))
      .digest('hex');
    return { indexVersion: this.version, query, liveRecordsSha256 };
  }

  phraseQuery(phrase, opts = {}) {
    const { slop = 0 } = opts;
    if (!Number.isInteger(slop) || slop < 0 || slop > MAX_SLOP) {
      throw new StoreError('INVALID_SLOP', `slop must be an integer between 0 and ${MAX_SLOP}`);
    }
    if (typeof phrase !== 'string') throw new StoreError('INVALID_QUERY', 'phrase must be a string');
    const terms = tokenize(phrase);
    if (terms.length === 0) throw new StoreError('INVALID_QUERY', 'phrase has no searchable terms');
    const matches = [];
    for (const doc of this.liveRecords()) {
      const lists = terms.map((t) => this.positionsFor(t, doc.id));
      if (lists.some((l) => l === null)) continue;
      const hits = findAlignments(lists, slop);
      if (hits.length > 0) {
        matches.push({
          id: doc.id,
          merchant: doc.merchant,
          amount: doc.amount,
          tags: doc.tags,
          status: doc.status,
          hits,
        });
      }
    }
    return { matches, certificate: this.certificate({ phrase, slop }) };
  }
}
