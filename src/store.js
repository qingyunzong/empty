import { MergeError } from './errors.js';
import { dedupId, keyOf, normalizeRecord, parseJsonl, stableStringify } from './record.js';

export function vectorSum(vector) {
  let sum = 0;
  for (const k in vector) sum += vector[k];
  return sum;
}

export function vectorMax(a, b) {
  const out = { ...a };
  for (const k in b) out[k] = Math.max(out[k] ?? 0, b[k]);
  return out;
}

// True when every component of `vector` is covered by `minVector`.
export function coveredBy(vector, minVector) {
  for (const k in vector) {
    if (vector[k] > (minVector[k] ?? 0)) return false;
  }
  return true;
}

// Total order over records carrying (vector, origin, seq). The vector sum is
// monotonic with vector-clock dominance, so causally newer records win; the
// (origin, seq, canonical form) tail makes the order total and therefore the
// merge commutative, associative and idempotent.
export function compareRecords(a, b) {
  const d = vectorSum(a.vector) - vectorSum(b.vector);
  if (d !== 0) return d;
  if (a.origin !== b.origin) return a.origin < b.origin ? -1 : 1;
  if (a.seq !== b.seq) return a.seq - b.seq;
  const ja = stableStringify(a);
  const jb = stableStringify(b);
  return ja < jb ? -1 : ja > jb ? 1 : 0;
}

function winner(records) {
  let best = null;
  for (const rec of records) {
    if (!best || compareRecords(rec, best) > 0) best = rec;
  }
  return best;
}

export class Store {
  constructor() {
    this.records = new Map(); // dedupId -> record
  }

  static fromJsonl(text, source = '<store>') {
    const store = new Store();
    for (const rec of parseJsonl(text, source)) store.add(rec);
    return store;
  }

  // Permissive add (CRDT union). Used by merge and by loading stores.
  add(rec) {
    if (rec.type === 'frontier') {
      const id = dedupId(rec);
      const cur = this.records.get(id);
      this.records.set(id, cur ? { ...rec, vector: vectorMax(cur.vector, rec.vector) } : rec);
      return rec;
    }
    const id = dedupId(rec);
    const cur = this.records.get(id);
    // Conflicting payloads under one identity: keep the lexicographically
    // smaller canonical form so the result is order-independent.
    if (!cur || stableStringify(rec) < stableStringify(cur)) {
      this.records.set(id, rec);
    }
    return rec;
  }

  // Validating batch ingest. Records are first merged into a tentative copy
  // (so registration order inside the batch does not matter), then every
  // correction is validated against the resulting state. Atomic: on error
  // this store is left untouched.
  ingestAll(records) {
    const next = new Store();
    next.records = new Map(this.records);
    for (const rec of records) next.add(rec);
    for (const rec of records) {
      if (rec.type === 'correction') {
        const state = next.siteState(rec.site);
        if (!state) throw new MergeError('UNKNOWN_SITE', `site ${JSON.stringify(rec.site)} is not registered`);
        if (state.op === 'delete') {
          throw new MergeError('TOMBSTONE_HIT', `site ${JSON.stringify(rec.site)} is deleted (tombstone)`);
        }
      } else if (rec.type === 'site' && rec.op === 'delete' && !next.siteRegistered(rec.site)) {
        throw new MergeError('UNKNOWN_SITE', `site ${JSON.stringify(rec.site)} is not registered`);
      }
    }
    this.records = next.records;
  }

  ingest(rec) {
    this.ingestAll([rec]);
    return rec;
  }

  siteRegistered(site) {
    for (const rec of this.records.values()) {
      if (rec.type === 'site' && rec.site === site && rec.op === 'register') return true;
    }
    return false;
  }

  merge(other) {
    for (const rec of other.records.values()) this.add(rec);
    return this;
  }

  siteState(site) {
    let best = null;
    for (const rec of this.records.values()) {
      if (rec.type === 'site' && rec.site === site && (!best || compareRecords(rec, best) > 0)) {
        best = rec;
      }
    }
    return best;
  }

  minVector() {
    const frontiers = [...this.records.values()].filter((r) => r.type === 'frontier');
    if (frontiers.length === 0) return {};
    const keys = new Set();
    for (const f of frontiers) for (const k in f.vector) keys.add(k);
    const min = {};
    for (const k of keys) {
      let m = Infinity;
      for (const f of frontiers) m = Math.min(m, f.vector[k] ?? 0);
      min[k] = m;
    }
    return min;
  }

  query({ site = null, from = null, to = null, includeInvalid = false } = {}) {
    const fromMs = from == null ? -Infinity : Date.parse(from);
    const toMs = to == null ? Infinity : Date.parse(to);
    if (Number.isNaN(fromMs)) throw new MergeError('BAD_RANGE', `--from is not a valid timestamp: ${from}`);
    if (Number.isNaN(toMs)) throw new MergeError('BAD_RANGE', `--to is not a valid timestamp: ${to}`);
    if (fromMs > toMs) throw new MergeError('BAD_RANGE', `--from (${from}) is after --to (${to})`);

    const winners = new Map();
    for (const rec of this.records.values()) {
      if (rec.type !== 'correction') continue;
      if (site && rec.site !== site) continue;
      const t = Date.parse(rec.time);
      if (t < fromMs || t > toMs) continue;
      const key = keyOf(rec);
      const cur = winners.get(key);
      if (!cur || compareRecords(rec, cur) > 0) winners.set(key, rec);
    }

    const rows = [];
    for (const rec of winners.values()) {
      const state = this.siteState(rec.site);
      const alive = state !== null && state.op === 'register';
      const base = {
        site: rec.site,
        time: rec.time,
        delta: rec.delta,
        origin: rec.origin,
        seq: rec.seq,
        vector: rec.vector,
      };
      if (!alive) {
        if (includeInvalid) rows.push({ ...base, valid: false, reason: 'tombstoned_site' });
        continue;
      }
      if (rec.invalid) {
        if (includeInvalid) rows.push({ ...base, valid: false, reason: 'out_of_range' });
        continue;
      }
      rows.push(base);
    }
    rows.sort((a, b) => (a.site < b.site ? -1 : a.site > b.site ? 1 : a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    return rows;
  }

  // Drop superseded loser records, but only for keys whose winning vector is
  // covered by the minimum frontier vector across replicas. Tombstones and
  // frontier records are always kept.
  compact() {
    const minVector = this.minVector();
    const next = new Store();
    const groups = new Map();
    for (const rec of this.records.values()) {
      if (rec.type !== 'correction') {
        next.add(rec);
        continue;
      }
      const key = keyOf(rec);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(rec);
    }
    for (const recs of groups.values()) {
      const win = winner(recs);
      if (coveredBy(win.vector, minVector)) {
        next.add(win);
      } else {
        for (const rec of recs) next.add(rec);
      }
    }
    return next;
  }

  toLines() {
    return [...this.records.values()].map((r) => stableStringify(r)).sort();
  }

  toJsonl() {
    const lines = this.toLines();
    return lines.length === 0 ? '' : lines.join('\n') + '\n';
  }
}

export { normalizeRecord, parseJsonl };
