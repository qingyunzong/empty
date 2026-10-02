'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { encodeVarint, decodeVarint } = require('./varint');

class IndexError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IndexError';
    this.code = code;
  }
}

function tokenize(text) {
  return String(text).toLowerCase().match(/[a-z0-9]+/g) || [];
}

function compareIds(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && String(na) === String(a) && String(nb) === String(b)) {
    return na - nb;
  }
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function sha256hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// Encode postings for one term: array of [docIdx, positions[]], sorted by docIdx.
function encodePostings(entries) {
  const bytes = [];
  encodeVarint(entries.length, bytes);
  let prevDoc = 0;
  for (const [docIdx, positions] of entries) {
    encodeVarint(docIdx - prevDoc, bytes);
    prevDoc = docIdx;
    encodeVarint(positions.length, bytes);
    let prevPos = 0;
    for (const p of positions) {
      encodeVarint(p - prevPos, bytes);
      prevPos = p;
    }
  }
  return Buffer.from(bytes).toString('base64');
}

function decodePostings(b64) {
  const buf = Buffer.from(b64, 'base64');
  let { value: docCount, offset } = decodeVarint(buf, 0);
  const entries = [];
  let prevDoc = 0;
  for (let i = 0; i < docCount; i += 1) {
    let r = decodeVarint(buf, offset);
    offset = r.offset;
    prevDoc += r.value;
    const docIdx = prevDoc;
    r = decodeVarint(buf, offset);
    offset = r.offset;
    const posCount = r.value;
    const positions = [];
    let prevPos = 0;
    for (let j = 0; j < posCount; j += 1) {
      r = decodeVarint(buf, offset);
      offset = r.offset;
      prevPos += r.value;
      positions.push(prevPos);
    }
    entries.push([docIdx, positions]);
  }
  return entries;
}

class Segment {
  constructor(id) {
    this.id = id;
    this.docIds = []; // sorted insertion order kept as array; index = docIdx
    this.texts = new Map(); // docId -> raw text
    this.postings = new Map(); // term -> Map(docId -> sorted positions)
    this.dead = new Set(); // tombstoned docIds
  }

  addDoc(docId, text) {
    if (this.texts.has(docId)) {
      throw new IndexError('DUPLICATE_DOC', `doc ${docId} already indexed`);
    }
    const tokens = tokenize(text);
    this.docIds.push(docId);
    this.texts.set(docId, text);
    tokens.forEach((term, pos) => {
      let m = this.postings.get(term);
      if (!m) {
        m = new Map();
        this.postings.set(term, m);
      }
      let arr = m.get(docId);
      if (!arr) {
        arr = [];
        m.set(docId, arr);
      }
      arr.push(pos);
    });
  }

  get size() {
    return this.docIds.length;
  }

  get deadRatio() {
    return this.size === 0 ? 0 : this.dead.size / this.size;
  }

  toJSON() {
    const docIdx = new Map(this.docIds.map((d, i) => [d, i]));
    const postings = {};
    for (const [term, m] of this.postings) {
      const entries = [...m.entries()]
        .map(([docId, positions]) => [docIdx.get(docId), positions])
        .sort((a, b) => a[0] - b[0]);
      postings[term] = encodePostings(entries);
    }
    return {
      id: this.id,
      docIds: this.docIds,
      texts: Object.fromEntries(this.texts),
      dead: [...this.dead],
      postings,
    };
  }

  static fromJSON(json) {
    const seg = new Segment(json.id);
    seg.docIds = json.docIds;
    seg.texts = new Map(Object.entries(json.texts));
    seg.dead = new Set(json.dead || []);
    seg.postings = new Map();
    for (const [term, b64] of Object.entries(json.postings)) {
      const m = new Map();
      for (const [docIdx, positions] of decodePostings(b64)) {
        m.set(seg.docIds[docIdx], positions);
      }
      seg.postings.set(term, m);
    }
    return seg;
  }
}

class PositionalIndex {
  constructor(dir, options = {}) {
    this.dir = dir;
    this.compactThreshold = options.compactThreshold ?? 0.5;
    this.segments = [];
    this.nextSegmentId = 1;
    fs.mkdirSync(dir, { recursive: true });
    this._load();
  }

  _manifestPath() {
    return path.join(this.dir, 'manifest.json');
  }

  _segmentPath(id) {
    return path.join(this.dir, `segment-${id}.json`);
  }

  _load() {
    if (!fs.existsSync(this._manifestPath())) return;
    const manifest = JSON.parse(fs.readFileSync(this._manifestPath(), 'utf8'));
    this.nextSegmentId = manifest.nextSegmentId;
    this.segments = manifest.segments.map((id) =>
      Segment.fromJSON(JSON.parse(fs.readFileSync(this._segmentPath(id), 'utf8'))));
  }

  _persistManifest() {
    const manifest = {
      nextSegmentId: this.nextSegmentId,
      segments: this.segments.map((s) => s.id),
    };
    const tmp = this._manifestPath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
    fs.renameSync(tmp, this._manifestPath());
  }

  _persistSegment(seg) {
    const tmp = this._segmentPath(seg.id) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(seg.toJSON()));
    fs.renameSync(tmp, this._segmentPath(seg.id));
  }

  _activeSegment() {
    let seg = this.segments[this.segments.length - 1];
    if (!seg) {
      seg = new Segment(this.nextSegmentId);
      this.nextSegmentId += 1;
      this.segments.push(seg);
    }
    return seg;
  }

  _locate(docId) {
    for (const seg of this.segments) {
      if (seg.texts.has(docId)) return seg;
    }
    return null;
  }

  addDoc(docId, text) {
    if (this._locate(docId)) {
      throw new IndexError('DUPLICATE_DOC', `doc ${docId} already indexed`);
    }
    const seg = this._activeSegment();
    seg.addDoc(docId, text);
    this._persistSegment(seg);
    this._persistManifest();
  }

  // Tombstone-first delete; compacts the segment if dead ratio exceeds threshold.
  deleteDoc(docId) {
    const seg = this._locate(docId);
    if (!seg) throw new IndexError('UNKNOWN_DOC', `doc ${docId} not found`);
    if (seg.dead.has(docId)) {
      throw new IndexError('DUPLICATE_DELETE', `doc ${docId} already deleted`);
    }
    seg.dead.add(docId); // tombstone written first
    this._persistSegment(seg);
    let compacted = null;
    if (seg.deadRatio > this.compactThreshold) {
      compacted = this._compactSegment(seg);
    }
    this._persistManifest();
    return { tombstoned: docId, segment: seg.id, compacted };
  }

  _compactSegment(seg) {
    const fresh = new Segment(this.nextSegmentId);
    this.nextSegmentId += 1;
    for (const docId of seg.docIds) {
      if (!seg.dead.has(docId)) fresh.addDoc(docId, seg.texts.get(docId));
    }
    const idx = this.segments.indexOf(seg);
    this.segments[idx] = fresh;
    this._persistSegment(fresh);
    fs.rmSync(this._segmentPath(seg.id), { force: true });
    return { from: seg.id, to: fresh.id, dropped: seg.dead.size };
  }

  compact() {
    const done = [];
    for (const seg of [...this.segments]) {
      if (seg.dead.size > 0) done.push(this._compactSegment(seg));
    }
    this._persistManifest();
    return done;
  }

  _liveDocs() {
    const out = [];
    for (const seg of this.segments) {
      for (const docId of seg.docIds) {
        if (!seg.dead.has(docId)) out.push({ seg, docId });
      }
    }
    return out;
  }

  _certificate(segmentIds, results) {
    return {
      segments: segmentIds,
      hash: sha256hex(JSON.stringify(results)),
    };
  }

  // Exact phrase match via positional intersection.
  phrase(query) {
    const terms = tokenize(query);
    if (terms.length === 0) {
      return { results: [], certificate: this._certificate([], []) };
    }
    const used = new Set();
    const hits = [];
    for (const seg of this.segments) {
      const first = seg.postings.get(terms[0]);
      if (!first) continue;
      let segUsed = false;
      for (const [docId, positions] of first) {
        if (seg.dead.has(docId)) continue;
        const matched = positions.some((start) =>
          terms.every((term, i) => {
            const m = seg.postings.get(term);
            const arr = m && m.get(docId);
            return arr && arr.includes(start + i);
          }));
        if (matched) {
          hits.push(docId);
          segUsed = true;
        }
      }
      if (segUsed) used.add(seg.id);
    }
    hits.sort(compareIds);
    return { results: hits, certificate: this._certificate([...used].sort((a, b) => a - b), hits) };
  }

  // Proximity: shortest window (position distance) covering both terms, <= k.
  // Results ordered by (window asc, id asc); equal shortest windows -> smallest id first.
  near(termA, termB, k = 5) {
    const [a] = tokenize(termA);
    const [b] = tokenize(termB);
    if (!a || !b) throw new IndexError('BAD_QUERY', 'near() needs two non-empty terms');
    const used = new Set();
    const hits = [];
    for (const seg of this.segments) {
      const pa = seg.postings.get(a);
      const pb = seg.postings.get(b);
      if (!pa || !pb) continue;
      let segUsed = false;
      for (const [docId, listA] of pa) {
        if (seg.dead.has(docId)) continue;
        const listB = pb.get(docId);
        if (!listB) continue;
        let best = Infinity;
        let i = 0;
        let j = 0;
        while (i < listA.length && j < listB.length) {
          const d = Math.abs(listA[i] - listB[j]);
          if (d < best) best = d;
          if (listA[i] < listB[j]) i += 1;
          else j += 1;
        }
        if (best <= k) {
          hits.push({ id: docId, window: best });
          segUsed = true;
        }
      }
      if (segUsed) used.add(seg.id);
    }
    hits.sort((x, y) => x.window - y.window || compareIds(x.id, y.id));
    return { results: hits, certificate: this._certificate([...used].sort((p, q) => p - q), hits) };
  }

  // Content hash over all live docs (order-independent).
  hash() {
    const rows = this._liveDocs()
      .map(({ docId, seg }) => `${docId}=${sha256hex(seg.texts.get(docId))}`)
      .sort();
    return sha256hex(rows.join('\n'));
  }

  stats() {
    return this.segments.map((s) => ({
      id: s.id,
      docs: s.size,
      dead: s.dead.size,
      deadRatio: s.deadRatio,
    }));
  }
}

module.exports = { PositionalIndex, IndexError, tokenize, compareIds, sha256hex };
