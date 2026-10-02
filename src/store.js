import fs from 'node:fs';
import path from 'node:path';
import { Index, IndexError, canonical, sha256hex } from './index.js';
import { encodeSegment, decodeSegment } from './varint.js';

const COMPACT_AFTER = 4; // compact when more than this many live segments exist

function isValidId(id) {
  return typeof id === 'string' && id.length > 0 && !id.includes('');
}

function cloneImage(image) {
  if (image == null) return null;
  const out = {};
  for (const [term, positions] of Object.entries(image)) out[term] = [...positions];
  return out;
}

// Append-only batch journal + varint-compressed posting segments.
// Live index = fold of effective (non-reverted) segments, where each
// segment's tombstones suppress postings carried by older segments.
export class Store {
  constructor(dir) {
    this.dir = dir;
    this.journalPath = path.join(dir, 'journal.jsonl');
    this.statePath = path.join(dir, 'state.json');
    this.segmentsDir = path.join(dir, 'segments');
    this.entries = [];
    this.journalHash = '';
    this.load();
  }

  load() {
    this.entries = [];
    this.journalHash = '';
    if (!fs.existsSync(this.journalPath)) return;
    const raw = fs.readFileSync(this.journalPath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    let prev = '';
    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        throw new IndexError('E_CORRUPT', 'journal: line is not valid JSON');
      }
      if (!entry || typeof entry !== 'object' || typeof entry.hash !== 'string') {
        throw new IndexError('E_CORRUPT', 'journal: malformed entry');
      }
      const { hash, ...body } = entry;
      if (entry.prev !== prev || sha256hex(`${prev}\n${canonical(body)}`) !== hash) {
        throw new IndexError('E_CORRUPT', `journal: hash chain broken at seq ${entry.seq}`);
      }
      prev = hash;
      this.entries.push(entry);
    }
    this.journalHash = prev;
  }

  revertedSet() {
    const reverted = new Set();
    for (const e of this.entries) {
      if (e.type === 'undo') reverted.add(e.target);
    }
    return reverted;
  }

  effectiveBatches() {
    const reverted = this.revertedSet();
    return this.entries
      .filter((e) => e.type === 'batch' && !reverted.has(e.seq))
      .sort((a, b) => a.seq - b.seq);
  }

  segmentPath(seq) {
    return path.join(this.segmentsDir, `seg-${String(seq).padStart(6, '0')}.json`);
  }

  compactPath(seq) {
    return path.join(this.segmentsDir, `compact-${String(seq).padStart(6, '0')}.json`);
  }

  listSegments() {
    if (!fs.existsSync(this.segmentsDir)) return { compact: null, segments: [] };
    let compact = null;
    const segments = [];
    for (const name of fs.readdirSync(this.segmentsDir)) {
      const filePath = path.join(this.segmentsDir, name);
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed.kind === 'compact') compact = { name, path: filePath, ...parsed };
      else segments.push({ name, path: filePath, ...parsed });
    }
    segments.sort((a, b) => a.seq - b.seq);
    return { compact, segments };
  }

  decodeSegmentFile(parsed) {
    try {
      return decodeSegment(Buffer.from(parsed.data, 'hex'));
    } catch (err) {
      throw new IndexError('E_CORRUPT', `segment ${parsed.name || ''}: ${err.message}`);
    }
  }

  // Fold effective segments into the live index. Tombstones in a newer
  // segment delete the docKey from everything accumulated so far, so a
  // deleted posting can never resurrect during the merge.
  foldIndex() {
    const index = new Index();
    const { compact, segments } = this.listSegments();
    const effective = new Set(this.effectiveBatches().map((b) => b.seq));
    const applySeg = (seg) => {
      for (const docKey of seg.tombstones) index.setImage(docKey, null);
      for (const [docKey, image] of Object.entries(seg.docs)) index.setImage(docKey, image);
    };
    if (compact) applySeg(this.decodeSegmentFile(compact));
    for (const segFile of segments) {
      if (!effective.has(segFile.seq)) continue;
      if (compact && segFile.seq <= compact.seq) continue;
      applySeg(this.decodeSegmentFile(segFile));
    }
    return index;
  }

  appendEntry(body) {
    const withPrev = { ...body, prev: this.journalHash };
    const hash = sha256hex(`${this.journalHash}\n${canonical(withPrev)}`);
    const entry = { ...withPrev, hash };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.journalPath, `${JSON.stringify(entry)}\n`);
    this.entries.push(entry);
    this.journalHash = hash;
    return entry;
  }

  writeState(indexHash) {
    const state = { seq: this.entries.length, indexHash, journalHash: this.journalHash };
    const tmp = `${this.statePath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(tmp, this.statePath);
  }

  writeSegment(seq, segObj) {
    fs.mkdirSync(this.segmentsDir, { recursive: true });
    const payload = { kind: 'segment', seq, codec: 'varint1', data: encodeSegment(segObj).toString('hex') };
    const filePath = this.segmentPath(seq);
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`);
    fs.renameSync(tmp, filePath);
  }

  // Build ops (with before-images as undo records) for a mutation.
  // mutations: [{ docKey, apply(index) -> afterImage|null }]
  commitBatch(mutations) {
    const index = this.foldIndex();
    const ops = [];
    for (const mutation of mutations) {
      const before = index.getImage(mutation.docKey);
      const after = mutation.apply(index);
      ops.push({ docKey: mutation.docKey, before, after: cloneImage(after) });
    }
    const seq = this.entries.length + 1;
    const segDocs = {};
    const segTombstones = [];
    for (const op of ops) {
      if (op.after == null) {
        delete segDocs[op.docKey];
        if (!segTombstones.includes(op.docKey)) segTombstones.push(op.docKey);
      } else {
        segDocs[op.docKey] = op.after;
        const at = segTombstones.indexOf(op.docKey);
        if (at >= 0) segTombstones.splice(at, 1);
      }
    }
    this.writeSegment(seq, { docs: segDocs, tombstones: segTombstones });
    this.appendEntry({ seq, type: 'batch', ops });
    this.writeState(index.hash());
    this.maybeCompact();
    return { batch: seq, count: ops.length };
  }

  addBatch(items) {
    for (const [i, item] of items.entries()) {
      if (!item || typeof item !== 'object') throw new IndexError('E_PARSE', `line ${i + 1}: not an object`);
      if (!isValidId(item.id)) throw new IndexError('E_PARSE', `line ${i + 1}: invalid id`);
      if (!Number.isInteger(item.version) || item.version < 1) {
        throw new IndexError('E_PARSE', `line ${i + 1}: version must be a positive integer`);
      }
      if (typeof item.text !== 'string') throw new IndexError('E_PARSE', `line ${i + 1}: text must be a string`);
    }
    const mutations = items.map((item) => ({
      docKey: Index.docKey(item.id, item.version),
      apply: (index) => {
        const image = Index.imageFromText(item.text);
        index.setImage(Index.docKey(item.id, item.version), image);
        return image;
      },
    }));
    return this.commitBatch(mutations);
  }

  delBatch(items) {
    for (const [i, item] of items.entries()) {
      if (!item || typeof item !== 'object') throw new IndexError('E_PARSE', `line ${i + 1}: not an object`);
      if (!isValidId(item.id)) throw new IndexError('E_PARSE', `line ${i + 1}: invalid id`);
      if (item.version !== undefined && (!Number.isInteger(item.version) || item.version < 1)) {
        throw new IndexError('E_PARSE', `line ${i + 1}: version must be a positive integer`);
      }
    }
    const index = this.foldIndex();
    const docKeys = [];
    for (const item of items) {
      if (item.version === undefined) {
        const prefix = `${item.id}`;
        const matches = index.docKeys().filter((k) => k.startsWith(prefix));
        if (matches.length === 0) {
          throw new IndexError('E_NOTFOUND', `no versions found for id ${JSON.stringify(item.id)}`);
        }
        docKeys.push(...matches);
      } else {
        const docKey = Index.docKey(item.id, item.version);
        if (!index.has(docKey)) {
          throw new IndexError('E_NOTFOUND', `document ${item.id} v${item.version} not found`);
        }
        docKeys.push(docKey);
      }
    }
    const mutations = docKeys.map((docKey) => ({
      docKey,
      apply: (index) => {
        index.setImage(docKey, null);
        return null;
      },
    }));
    return this.commitBatch(mutations);
  }

  // Undo specs: { batch: n } reverts one batch, { to: k } reverts every
  // effective batch with seq > k. All specs are validated before any write.
  undo(specs) {
    const targets = [];
    for (const spec of specs) {
      if (!spec || typeof spec !== 'object') throw new IndexError('E_PARSE', 'undo spec must be an object');
      if (spec.batch !== undefined) {
        if (!Number.isInteger(spec.batch) || spec.batch < 1) throw new IndexError('E_PARSE', 'batch must be a positive integer');
        targets.push(spec.batch);
      } else if (spec.to !== undefined) {
        if (!Number.isInteger(spec.to) || spec.to < 0) throw new IndexError('E_PARSE', 'to must be a non-negative integer');
        for (const b of this.effectiveBatches()) if (b.seq > spec.to) targets.push(b.seq);
      } else {
        throw new IndexError('E_PARSE', 'undo spec needs "batch" or "to"');
      }
    }
    const reverted = this.revertedSet();
    const bySeq = new Map(this.entries.map((e) => [e.seq, e]));
    const uniqueTargets = [...new Set(targets)].sort((a, b) => a - b);
    for (const t of uniqueTargets) {
      const entry = bySeq.get(t);
      if (!entry) throw new IndexError('E_NOTFOUND', `batch ${t} not found`);
      if (entry.type !== 'batch') throw new IndexError('E_UNDO', `entry ${t} is not a data batch`);
      if (reverted.has(t)) throw new IndexError('E_UNDO', `batch ${t} is already reverted`);
    }

    // A revert touching a batch inside the compact snapshot invalidates it
    // before any rebuild fold below.
    this.invalidateCompactIfNeeded(uniqueTargets);
    const index = this.foldIndex();
    const revertedNow = [];
    for (const target of uniqueTargets) {
      const effective = this.effectiveBatches();
      const at = effective.findIndex((b) => b.seq === target);
      const after = effective.slice(at + 1);
      // Replay: unwind later batches (newest first), revert target, redo the rest.
      for (let j = after.length - 1; j >= 0; j -= 1) this.applyInverse(index, after[j]);
      this.applyInverse(index, effective[at]);
      for (const b of after) this.applyForward(index, b);
      const seq = this.entries.length + 1;
      this.appendEntry({ seq, type: 'undo', target });
      revertedNow.push(target);
    }
    const indexHash = index.hash();
    const rebuildHash = this.foldIndex().hash();
    if (indexHash !== rebuildHash) {
      throw new IndexError('E_CORRUPT', 'undo replay diverged from rebuild');
    }
    this.writeState(indexHash);
    return { reverted: revertedNow, indexHash, rebuildHash };
  }

  applyInverse(index, batch) {
    for (let i = batch.ops.length - 1; i >= 0; i -= 1) {
      index.setImage(batch.ops[i].docKey, cloneImage(batch.ops[i].before));
    }
  }

  applyForward(index, batch) {
    for (const op of batch.ops) index.setImage(op.docKey, cloneImage(op.after));
  }

  invalidateCompactIfNeeded(revertedSeqs) {
    const { compact } = this.listSegments();
    if (!compact) return;
    if (revertedSeqs.some((s) => s <= compact.seq)) fs.unlinkSync(compact.path);
  }

  // Merge all effective segments into one compacted snapshot. Tombstones
  // are resolved (deleted postings are gone from the snapshot) and old
  // segment files are kept on disk so that later undo replay can still
  // reconstruct history; the snapshot is invalidated by any undo that
  // touches a batch it covers.
  maybeCompact() {
    const { compact, segments } = this.listSegments();
    const effective = new Set(this.effectiveBatches().map((b) => b.seq));
    const live = segments.filter((s) => effective.has(s.seq) && (!compact || s.seq > compact.seq));
    if (live.length <= COMPACT_AFTER) return false;
    const index = this.foldIndex();
    const docs = {};
    for (const docKey of index.docKeys()) docs[docKey] = index.getImage(docKey);
    const maxSeq = Math.max(...live.map((s) => s.seq), compact ? compact.seq : 0);
    const payload = { kind: 'compact', seq: maxSeq, codec: 'varint1', data: encodeSegment({ docs, tombstones: [] }).toString('hex') };
    fs.writeFileSync(this.compactPath(maxSeq), `${JSON.stringify(payload)}\n`);
    return true;
  }

  verify() {
    const problems = [];
    // 1. Journal hash chain (load() already validated it on open).
    // 2. State file matches journal tip and folded index.
    let state = null;
    if (fs.existsSync(this.statePath)) {
      try {
        state = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      } catch {
        problems.push('state.json: not valid JSON');
      }
    }
    if (state) {
      if (state.journalHash !== this.journalHash) problems.push('state.json: journal hash mismatch');
      if (state.seq !== this.entries.length) problems.push('state.json: seq mismatch');
    } else if (this.entries.length > 0) {
      problems.push('state.json: missing');
    }
    // 3. Every segment decodes and re-encodes to identical bytes.
    const { compact, segments } = this.listSegments();
    for (const segFile of [...(compact ? [compact] : []), ...segments]) {
      let decoded;
      try {
        decoded = decodeSegment(Buffer.from(segFile.data, 'hex'));
      } catch (err) {
        problems.push(`segment ${segFile.name}: ${err.message}`);
        continue;
      }
      if (encodeSegment(decoded).toString('hex') !== segFile.data) {
        problems.push(`segment ${segFile.name}: varint re-encode mismatch`);
      }
    }
    // 4. Folded index hash matches the recorded state.
    const index = this.foldIndex();
    const indexHash = index.hash();
    if (state && state.indexHash !== indexHash) problems.push('index hash mismatch with state.json');
    if (problems.length > 0) throw new IndexError('E_CORRUPT', problems.join('; '));
    return {
      batches: this.entries.filter((e) => e.type === 'batch').length,
      reverted: [...this.revertedSet()].sort((a, b) => a - b),
      docs: index.docKeys().length,
      indexHash,
      journalHash: this.journalHash,
    };
  }
}
