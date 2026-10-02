import { SiteAgg } from './fenwick.js';

export function keyId(site, timeMs) {
  return JSON.stringify([site, timeMs]);
}

export function parseKeyId(id) {
  const [site, time] = JSON.parse(id);
  return { site, time };
}

// Total order for "which version is later": Lamport clock first, then site
// (deterministic tie-break for merged concurrent histories), then log seq.
export function compareEvents(a, b) {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  if (a.site !== b.site) return a.site < b.site ? -1 : 1;
  return a.seq - b.seq;
}

// Fold a key's candidate versions (skipping undone batches) into the single
// currently visible version. Delete is a tombstone: it masks earlier
// versions but never removes them, so undoing the delete restores them.
// Flag is quality-only: it carries the previous visible value forward,
// resolved dynamically so undoing an earlier batch re-anchors it correctly.
export function foldCandidates(candidates, undone) {
  const visible = candidates.filter((c) => !undone.has(c.batchId));
  visible.sort(compareEvents);
  let v = null;
  for (const c of visible) {
    const op = c.type === 'ingest' ? 'replace' : c.op;
    if (op === 'replace') {
      v = { value: c.value ?? null, quality: c.quality ?? 'good' };
    } else if (op === 'flag') {
      v = { value: v ? v.value : null, quality: c.quality ?? 'unknown' };
    } else if (op === 'delete') {
      v = { deleted: true };
    }
  }
  return v;
}

// Materialized bitemporal state: per-key candidate chains, batch registry,
// folded current versions, and per-site incremental aggregates.
export class State {
  constructor() {
    this.seq = 0;
    this.lamport = 0;
    this.batches = new Map(); // batchId -> { type, keys:Set, undone }
    this.keys = new Map(); // keyId -> { site, time, candidates:[] }
    this.current = new Map(); // keyId -> folded version | null
    this.aggs = new Map(); // site -> SiteAgg
    this.undone = new Set(); // undone batchIds
  }

  applyEvent(ev) {
    this.seq = Math.max(this.seq, ev.seq);
    this.lamport = Math.max(this.lamport, ev.lamport);
    if (ev.type === 'undo') {
      const batch = this.batches.get(ev.undoOf);
      if (batch && !batch.undone) {
        batch.undone = true;
        this.undone.add(ev.undoOf);
        for (const id of batch.keys) this._refold(id);
      }
      return;
    }
    const id = keyId(ev.site, ev.time);
    let batch = this.batches.get(ev.batchId);
    if (!batch) {
      batch = { type: ev.type, keys: new Set(), undone: false };
      this.batches.set(ev.batchId, batch);
    }
    batch.keys.add(id);
    let entry = this.keys.get(id);
    if (!entry) {
      entry = { site: ev.site, time: ev.time, candidates: [] };
      this.keys.set(id, entry);
    }
    entry.candidates.push(ev);
    this._refold(id);
  }

  _refold(id) {
    const entry = this.keys.get(id);
    const version = foldCandidates(entry.candidates, this.undone);
    this.current.set(id, version);
    let agg = this.aggs.get(entry.site);
    if (!agg) {
      agg = new SiteAgg();
      this.aggs.set(entry.site, agg);
    }
    agg.set(entry.time, version);
  }

  toJSON() {
    const batches = {};
    for (const [id, b] of this.batches) {
      batches[id] = { type: b.type, keys: [...b.keys], undone: b.undone };
    }
    const keys = {};
    for (const [id, e] of this.keys) {
      keys[id] = { site: e.site, time: e.time, candidates: e.candidates };
    }
    return {
      seq: this.seq,
      lamport: this.lamport,
      undone: [...this.undone],
      batches,
      keys,
    };
  }

  static fromJSON(j) {
    const s = new State();
    s.seq = j.seq;
    s.lamport = j.lamport;
    for (const [id, b] of Object.entries(j.batches)) {
      s.batches.set(id, { type: b.type, keys: new Set(b.keys), undone: b.undone });
    }
    s.undone = new Set(j.undone);
    for (const [id, e] of Object.entries(j.keys)) {
      s.keys.set(id, { site: e.site, time: e.time, candidates: e.candidates });
    }
    for (const id of s.keys.keys()) s._refold(id);
    return s;
  }
}
