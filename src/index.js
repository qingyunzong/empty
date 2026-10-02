import fs from 'node:fs';
import path from 'node:path';
import { encodeSegment, decodeSegment } from './segment.js';

// Compressed positional inverted index with tombstone deletion and compaction.
// Layout inside the data dir:
//   index/manifest.json     { nextSegId, segments: [{id, file, positions}] }
//   index/tombstones.json   { [segId]: [tradeId, ...] }
//   index/seg-<id>.gz       gzip compressed, varint delta-encoded postings
export class PositionalIndex {
  constructor(dir, { compactionThreshold = 0.5 } = {}) {
    this.dir = path.join(dir, 'index');
    this.threshold = compactionThreshold;
    this.segments = [];
    this.active = PositionalIndex.#newSegment(0);
    this.tombstones = new Map();
    this.nextSegId = 1;
  }

  static #newSegment(id) {
    return { id, file: null, postings: {}, docs: new Set(), positions: 0, dead: 0 };
  }

  static open(dir, opts = {}) {
    const index = new PositionalIndex(dir, opts);
    const manifestPath = path.join(index.dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return index;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    index.nextSegId = manifest.nextSegId;
    const tombRaw = JSON.parse(
      fs.readFileSync(path.join(index.dir, 'tombstones.json'), 'utf8'),
    );
    for (const [segId, ids] of Object.entries(tombRaw)) {
      index.tombstones.set(Number(segId), new Set(ids));
    }
    for (const meta of manifest.segments) {
      const seg = decodeSegment(fs.readFileSync(path.join(index.dir, meta.file)));
      seg.file = meta.file;
      const tomb = index.tombstones.get(seg.id);
      if (tomb) {
        for (const id of tomb) seg.dead += PositionalIndex.#docPositions(seg, id);
      }
      index.segments.push(seg);
    }
    return index;
  }

  static #docPositions(seg, tradeId) {
    let n = 0;
    for (const docs of Object.values(seg.postings)) {
      if (docs[tradeId]) n += docs[tradeId].length;
    }
    return n;
  }

  addDocument(tradeId, tokens) {
    const seg = this.active;
    seg.docs.add(tradeId);
    tokens.forEach((term, pos) => {
      const docs = (seg.postings[term] ??= {});
      (docs[tradeId] ??= []).push(pos);
      seg.positions += 1;
    });
  }

  // Tombstone-first delete: on-disk segments get tombstones; the unflushed
  // active segment is scrubbed in place. Returns affected segment ids and the
  // number of dead positions created.
  deleteDocument(tradeId) {
    const affected = [];
    let dead = 0;
    for (const seg of this.segments) {
      if (!seg.docs.has(tradeId)) continue;
      if (!this.tombstones.has(seg.id)) this.tombstones.set(seg.id, new Set());
      this.tombstones.get(seg.id).add(tradeId);
      const n = PositionalIndex.#docPositions(seg, tradeId);
      seg.dead += n;
      dead += n;
      affected.push(seg.id);
    }
    if (this.active.docs.has(tradeId)) {
      dead += PositionalIndex.#docPositions(this.active, tradeId);
      for (const [term, docs] of Object.entries(this.active.postings)) {
        if (docs[tradeId]) {
          delete docs[tradeId];
          if (Object.keys(docs).length === 0) delete this.active.postings[term];
        }
      }
      this.active.docs.delete(tradeId);
      this.active.positions = 0;
      for (const docs of Object.values(this.active.postings)) {
        for (const pos of Object.values(docs)) this.active.positions += pos.length;
      }
      affected.push('active');
    }
    return { segments: affected, positions: dead };
  }

  flush() {
    if (this.active.positions === 0) return null;
    const id = this.nextSegId++;
    const seg = { ...this.active, id, file: `seg-${id}.gz` };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, seg.file), encodeSegment(seg));
    this.segments.push(seg);
    this.active = PositionalIndex.#newSegment(0);
    return id;
  }

  save() {
    this.flush();
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(
      path.join(this.dir, 'manifest.json'),
      JSON.stringify({
        nextSegId: this.nextSegId,
        segments: this.segments.map((s) => ({
          id: s.id,
          file: s.file,
          positions: s.positions,
        })),
      }),
    );
    const tomb = {};
    for (const [segId, ids] of this.tombstones) tomb[segId] = [...ids];
    fs.writeFileSync(path.join(this.dir, 'tombstones.json'), JSON.stringify(tomb));
  }

  // Rewrite any segment whose dead-position ratio exceeds the threshold.
  compact() {
    const compacted = [];
    for (const seg of this.segments) {
      if (seg.positions === 0 || seg.dead / seg.positions <= this.threshold) continue;
      const tomb = this.tombstones.get(seg.id) ?? new Set();
      const postings = {};
      let positions = 0;
      for (const [term, docs] of Object.entries(seg.postings)) {
        for (const [tradeId, pos] of Object.entries(docs)) {
          if (tomb.has(tradeId)) continue;
          (postings[term] ??= {})[tradeId] = pos;
          positions += pos.length;
        }
      }
      seg.postings = postings;
      seg.docs = new Set([...seg.docs].filter((id) => !tomb.has(id)));
      seg.positions = positions;
      seg.dead = 0;
      this.tombstones.delete(seg.id);
      fs.writeFileSync(path.join(this.dir, seg.file), encodeSegment(seg));
      compacted.push(seg.id);
    }
    if (compacted.length > 0) this.save();
    return compacted;
  }

  getPostings(term) {
    const out = new Map();
    const collect = (seg) => {
      const docs = seg.postings[term];
      if (!docs) return;
      const tomb = this.tombstones.get(seg.id);
      for (const [tradeId, pos] of Object.entries(docs)) {
        if (tomb?.has(tradeId)) continue;
        if (!out.has(tradeId)) out.set(tradeId, []);
        out.get(tradeId).push(...pos);
      }
    };
    for (const seg of this.segments) collect(seg);
    collect(this.active);
    for (const pos of out.values()) pos.sort((a, b) => a - b);
    return out;
  }

  segmentReport() {
    const report = this.segments.map((s) => ({
      id: s.id,
      file: s.file,
      docs: s.docs.size,
      positions: s.positions,
      dead: s.dead,
      tombstoned: [...(this.tombstones.get(s.id) ?? [])],
    }));
    if (this.active.positions > 0) {
      report.push({
        id: 'active',
        file: null,
        docs: this.active.docs.size,
        positions: this.active.positions,
        dead: 0,
        tombstoned: [],
      });
    }
    return report;
  }
}
