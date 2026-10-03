// Core store model for offline merge of multi-station weather corrections.
//
// A store is a JSONL file with three record kinds:
//   {"type":"site","site":"S1"}                                   site registry
//   {"type":"base","vector":{...}}                                compact horizon (GC watermark)
//   {"type":"put"|"del","key":{"site","t"},...,"vector","origin","seq"}  events
//
// Key = (site, time). Every event carries (vector, origin, seq).
// Merge semantics: strict causal domination wins; among concurrent maximal
// events a tombstone (del) beats a put (remove-wins); remaining ties are
// broken by a deterministic total order (seq, origin, canonical form).
// Merge of stores is set-union + dedupe + horizon filter, hence
// commutative, associative and idempotent.

import fs from 'node:fs';
import { vecLeq, vecStrict, vecMax, vecMin } from './vector.js';

export class WxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WxError';
    this.code = code; // BAD_RANGE | UNKNOWN_SITE | TOMBSTONE_HIT
  }
}

export const SOFT_RANGE = 15; // |delta| beyond this is kept but flagged invalid (evidence)
export const HARD_RANGE = 100; // |delta| beyond this is rejected with BAD_RANGE

const KEY_SEP = '\u0000';
export const keyId = (key) => key.site + KEY_SEP + key.t;

function sortVec(v) {
  return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export function canonicalEvent(e) {
  const o = { type: e.type, key: { site: e.key.site, t: e.key.t } };
  if (e.type === 'put') {
    o.delta = e.delta;
    o.valid = e.valid;
  }
  o.vector = sortVec(e.vector);
  o.origin = e.origin;
  o.seq = e.seq;
  if (e.pin) o.pin = true;
  return o;
}

// Events are treated as immutable once created, so the canonical id can be cached.
const idCache = new WeakMap();
export function eventId(e) {
  let id = idCache.get(e);
  if (id === undefined) {
    id = JSON.stringify(canonicalEvent(e));
    idCache.set(e, id);
  }
  return id;
}

export function normTime(t, where) {
  const d = typeof t === 'string' ? new Date(t) : new Date(NaN);
  if (Number.isNaN(d.getTime())) {
    throw new WxError('BAD_RANGE', `${where}: invalid timestamp ${JSON.stringify(t)}`);
  }
  return d.toISOString();
}

function normVector(v, where) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new WxError('BAD_RANGE', `${where}: invalid vector clock`);
  }
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (!Number.isInteger(x) || x < 0) {
      throw new WxError('BAD_RANGE', `${where}: invalid vector component ${k}=${x}`);
    }
    if (x > 0) out[k] = x;
  }
  return out;
}

function parseEvent(obj, where) {
  if (!obj || typeof obj !== 'object') throw new WxError('BAD_RANGE', `${where}: not an object`);
  if (obj.type !== 'put' && obj.type !== 'del') {
    throw new WxError('BAD_RANGE', `${where}: unknown event type ${JSON.stringify(obj.type)}`);
  }
  const key = {
    site: obj.key?.site,
    t: normTime(obj.key?.t, where),
  };
  if (typeof key.site !== 'string' || key.site.length === 0) {
    throw new WxError('BAD_RANGE', `${where}: invalid key site`);
  }
  const e = {
    type: obj.type,
    key,
    vector: normVector(obj.vector ?? {}, where),
    origin: obj.origin,
    seq: obj.seq,
  };
  if (typeof e.origin !== 'string' || e.origin.length === 0) {
    throw new WxError('BAD_RANGE', `${where}: invalid origin`);
  }
  if (!Number.isInteger(e.seq) || e.seq < 1) {
    throw new WxError('BAD_RANGE', `${where}: invalid seq ${JSON.stringify(obj.seq)}`);
  }
  if (obj.type === 'put') {
    if (typeof obj.delta !== 'number' || !Number.isFinite(obj.delta)) {
      throw new WxError('BAD_RANGE', `${where}: delta must be a finite number`);
    }
    e.delta = obj.delta;
    e.valid = obj.valid !== false;
  }
  if (obj.pin === true) e.pin = true;
  return e;
}

export function parseStore(text, source = '<store>') {
  const sites = new Set();
  const rawEvents = [];
  let base = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const where = `${source}:${i + 1}`;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new WxError('BAD_RANGE', `${where}: invalid JSON`);
    }
    if (obj !== null && typeof obj === 'object' && obj.type === 'site') {
      if (typeof obj.site !== 'string' || !obj.site) {
        throw new WxError('BAD_RANGE', `${where}: invalid site record`);
      }
      sites.add(obj.site);
    } else if (obj !== null && typeof obj === 'object' && obj.type === 'base') {
      base = vecMax(base, normVector(obj.vector ?? {}, where));
    } else {
      rawEvents.push(parseEvent(obj, where));
    }
  }
  const seen = new Set();
  const events = [];
  for (const e of rawEvents) {
    const id = eventId(e);
    if (seen.has(id)) continue;
    seen.add(id);
    events.push(e);
  }
  return { sites, events, base };
}

export function loadStore(path) {
  if (!fs.existsSync(path)) return { sites: new Set(), events: [], base: {} };
  return parseStore(fs.readFileSync(path, 'utf8'), path);
}

function compareEvents(a, b) {
  const ka = keyId(a.key);
  const kb = keyId(b.key);
  if (ka !== kb) return ka < kb ? -1 : 1;
  if (a.origin !== b.origin) return a.origin < b.origin ? -1 : 1;
  if (a.seq !== b.seq) return a.seq - b.seq;
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  const ia = eventId(a);
  const ib = eventId(b);
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

export function serializeStore(store) {
  const lines = [];
  for (const s of [...store.sites].sort()) lines.push(JSON.stringify({ type: 'site', site: s }));
  if (Object.keys(store.base).length > 0) {
    lines.push(JSON.stringify({ type: 'base', vector: sortVec(store.base) }));
  }
  for (const e of [...store.events].sort(compareEvents)) lines.push(eventId(e));
  return lines.length === 0 ? '' : lines.join('\n') + '\n';
}

export function storeVector(store) {
  let v = { ...store.base };
  for (const e of store.events) v = vecMax(v, e.vector);
  return v;
}

// Deterministic total order used to break ties between concurrent events.
export function tieCompare(a, b) {
  if (a.seq !== b.seq) return a.seq - b.seq;
  if (a.origin !== b.origin) return a.origin < b.origin ? -1 : 1;
  const ia = eventId(a);
  const ib = eventId(b);
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

// The single visible/tombstone winner of one key, as a pure function of the
// event SET (order independent by construction).
export function winnerOf(events) {
  const candidates = events.filter(
    (e) => !events.some((o) => vecStrict(e.vector, o.vector)),
  );
  const dels = candidates.filter((e) => e.type === 'del');
  const pool = dels.length > 0 ? dels : candidates;
  return pool.reduce((best, e) => (tieCompare(e, best) > 0 ? e : best));
}

function groupByKey(events) {
  const byKey = new Map();
  for (const e of events) {
    const id = keyId(e.key);
    let arr = byKey.get(id);
    if (arr === undefined) {
      arr = [];
      byKey.set(id, arr);
    }
    arr.push(e);
  }
  return byKey;
}

export function materialize(store) {
  const out = new Map();
  for (const [id, events] of groupByKey(store.events)) {
    out.set(id, { key: events[0].key, event: winnerOf(events) });
  }
  return out;
}

export function queryStore(store, opts = {}) {
  const { site = null, from = null, to = null, includeInvalid = false } = opts;
  if (site !== null && !store.sites.has(site)) {
    throw new WxError('UNKNOWN_SITE', `unknown site: ${site}`);
  }
  const fromT = from !== null ? normTime(from, 'query --from') : null;
  const toT = to !== null ? normTime(to, 'query --to') : null;
  const rows = [];
  for (const { key, event } of materialize(store).values()) {
    if (event.type === 'del') continue; // tombstoned keys are invisible
    if (!event.valid && !includeInvalid) continue; // invalid corrections filtered, evidence kept in store
    if (site !== null && key.site !== site) continue;
    if (fromT !== null && key.t < fromT) continue;
    if (toT !== null && key.t > toT) continue;
    const row = { site: key.site, t: key.t, delta: event.delta };
    if (!event.valid) row.valid = false;
    rows.push(row);
  }
  rows.sort((a, b) => (a.site === b.site ? (a.t < b.t ? -1 : 1) : a.site < b.site ? -1 : 1));
  return rows;
}

// Ingest one station's correction stream (array of {t, delta?, delete?, seq?})
// into a store. Validates the whole stream before appending (atomic ingest).
export function ingestRecords(store, site, records) {
  if (typeof site !== 'string' || site.length === 0) {
    throw new WxError('BAD_RANGE', 'ingest: site must be a non-empty string');
  }
  const knowledge = storeVector(store);
  const seen = new Set(store.events.map((e) => e.origin + KEY_SEP + e.seq));
  const byKey = groupByKey(store.events);
  const pending = [];
  let skipped = 0;
  let nextSeq = (knowledge[site] ?? 0) + 1;

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const where = `input:${i + 1}`;
    const t = normTime(rec?.t, where);
    const seq = rec?.seq ?? nextSeq;
    if (!Number.isInteger(seq) || seq < 1) {
      throw new WxError('BAD_RANGE', `${where}: invalid seq ${JSON.stringify(rec?.seq)}`);
    }
    nextSeq = Math.max(nextSeq, seq + 1);
    if (rec?.delete !== true) {
      const delta = rec?.delta;
      if (typeof delta !== 'number' || !Number.isFinite(delta)) {
        throw new WxError('BAD_RANGE', `${where}: delta must be a finite number`);
      }
      if (Math.abs(delta) > HARD_RANGE) {
        throw new WxError(
          'BAD_RANGE',
          `${where}: |delta| ${Math.abs(delta)} exceeds hard range ${HARD_RANGE}`,
        );
      }
    }
    if (seen.has(site + KEY_SEP + seq)) {
      skipped++; // duplicate ingest is a no-op (idempotent)
      continue;
    }
    seen.add(site + KEY_SEP + seq);
    const vector = { ...knowledge, [site]: seq };
    for (const [k, x] of Object.entries(vector)) {
      knowledge[k] = Math.max(knowledge[k] ?? 0, x);
    }
    if (vecLeq(vector, store.base)) {
      skipped++; // already collected by a previous compact horizon
      continue;
    }
    const key = { site, t };
    if (rec?.delete === true) {
      pending.push({ type: 'del', key, vector, origin: site, seq });
      continue;
    }
    const delta = rec.delta;
    const id = keyId(key);
    const existing = byKey.get(id) ?? [];
    const related = existing.concat(pending.filter((p) => keyId(p.key) === id));
    if (related.length > 0 && winnerOf(related).type === 'del') {
      throw new WxError('TOMBSTONE_HIT', `${where}: key ${site}@${t} is deleted (tombstone)`);
    }
    const event = {
      type: 'put',
      key,
      delta,
      valid: Math.abs(delta) <= SOFT_RANGE,
      vector,
      origin: site,
      seq,
    };
    pending.push(event);
  }

  store.sites.add(site);
  store.events.push(...pending);
  return {
    added: pending.length,
    skipped,
    invalid: pending.filter((p) => p.type === 'put' && !p.valid).length,
  };
}

// Merge any number of stores. Pure union + dedupe + horizon filter, so the
// result does not depend on input order or grouping.
export function mergeStores(stores) {
  const sites = new Set();
  let base = {};
  const all = [];
  for (const s of stores) {
    for (const x of s.sites) sites.add(x);
    base = vecMax(base, s.base);
    all.push(...s.events);
  }
  const seen = new Set();
  const events = [];
  for (const e of all) {
    // Stale events at/below the compact horizon are already accounted for.
    // Events pinned by a compact are the legitimate surviving state and pass.
    if (!e.pin && vecLeq(e.vector, base)) continue;
    const id = eventId(e);
    if (seen.has(id)) continue;
    seen.add(id);
    events.push(e);
  }
  return { sites, events, base };
}

// Garbage-collect events that every registered site is known to have seen
// (vector <= min vector across sites). Tombstones are collected only when the
// whole key is covered; put winners are always kept (invalid ones included,
// as evidence). Survivors at/below the new horizon are pinned so future
// merges do not mistake them for stale events.
export function compactStore(store) {
  const knowledge = new Map();
  for (const s of store.sites) knowledge.set(s, { ...store.base });
  for (const e of store.events) {
    if (!knowledge.has(e.origin)) knowledge.set(e.origin, { ...store.base });
    knowledge.set(e.origin, vecMax(knowledge.get(e.origin), e.vector));
  }
  const vMin = vecMin([...knowledge.values()]);
  const base = Object.fromEntries(
    Object.entries(vecMax(store.base, vMin)).filter(([, x]) => x > 0),
  );
  const kept = [];
  let dropped = 0;
  for (const events of groupByKey(store.events).values()) {
    const w = winnerOf(events);
    if (w.type === 'del' && events.every((e) => vecLeq(e.vector, vMin))) {
      dropped += events.length; // fully covered tombstone: collect the whole key
      continue;
    }
    for (const e of events) {
      if (e !== w && vecLeq(e.vector, vMin)) {
        dropped++; // covered loser, cannot influence any future result
        continue;
      }
      kept.push(e);
    }
  }
  const pinnedKept = kept.map((e) => {
    const need = vecLeq(e.vector, base);
    if (need && !e.pin) return { ...e, pin: true };
    if (!need && e.pin) {
      const { pin, ...rest } = e;
      return rest;
    }
    return e;
  });
  return {
    store: { sites: new Set(store.sites), events: pinnedKept, base },
    dropped,
    base,
  };
}
