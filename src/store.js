// Shift-log store: ingest / merge / equiv / explain / snapshot / restore.
//
// Semantics
// ---------
// A log is a set of events; each event has an id, direct causal predecessors
// (preds) and an optional state payload. The canonical form of a log is the
// reachability relation (transitive closure) of its event partial order after
// SCC compression, plus per-event canonical state and the boundary snapshot
// (source/sink components of the condensation DAG).
//
// Verdict rules for equiv(a, b):
//   NOT_EQUAL  - positive contradiction: a shared event carries a different
//                state payload, or the two reachability relations restricted
//                to shared events are incomparable (each orders some pair the
//                other cannot derive, e.g. x<y in one and y<x in the other).
//   EQUAL      - identical recorded event sets, identical external references,
//                identical states, identical restricted closures.
//   UNDECIDED  - every difference is explainable by missing information:
//                one side's restricted closure is a subset of the other's,
//                or one side is missing events / external references. Missing
//                information is never reported as inconsistency.

import { createHash } from 'node:crypto';
import { analyzeEvents, reachIdx, shortestPathEdges } from './graph.js';

export const MAGIC = 'shiftlog-snapshot';
export const SNAPSHOT_VERSION = 1;
const MISSING_EDGE_CAP = 100;
// Unquoted sentinel: cannot collide with any JSON-encoded string (those are quoted).
const UNDEF_TOKEN = '#undefined#';

export function canon(value) {
  const seen = new Set();
  const enc = (v) => {
    if (v === undefined) return UNDEF_TOKEN;
    if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') {
      return JSON.stringify(v);
    }
    if (typeof v !== 'object') throw new Error('unsupported state type');
    if (seen.has(v)) throw new Error('circular state');
    seen.add(v);
    let out;
    if (Array.isArray(v)) {
      out = '[' + v.map(enc).join(',') + ']';
    } else {
      out = '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + enc(v[k])).join(',') + '}';
    }
    seen.delete(v);
    return out;
  };
  return enc(value);
}

function invalid(error, extra = {}) {
  return { status: 'INVALID_INPUT', error, ...extra };
}

function validateEvent(e) {
  if (e === null || typeof e !== 'object' || Array.isArray(e)) return 'event must be an object';
  if (typeof e.id !== 'string' || e.id.length === 0) return 'event.id must be a non-empty string';
  if (e.preds !== undefined) {
    if (!Array.isArray(e.preds)) return 'event.preds must be an array';
    for (const p of e.preds) {
      if (typeof p !== 'string' || p.length === 0) return 'event.preds must contain non-empty strings';
    }
  }
  if (e.state !== undefined) {
    try {
      canon(e.state);
    } catch (err) {
      return 'event.state is not serializable: ' + err.message;
    }
  }
  return null;
}

function summarize(an) {
  return {
    events: an.recorded.size,
    edges: an.directEdges.length,
    components: an.compCount,
    sources: an.sources,
    sinks: an.sinks,
    externals: an.externals,
  };
}

function lexPairCmp(p, q) {
  if (p[0] !== q[0]) return p[0] < q[0] ? -1 : 1;
  if (p[1] !== q[1]) return p[1] < q[1] ? -1 : 1;
  return 0;
}

function missingEdges(A, B) {
  const list = [];
  let total = 0;
  const seen = new Set();
  const push = (from, to, side) => {
    const key = from + ' ' + to + ' ' + side;
    if (seen.has(key)) return;
    seen.add(key);
    total++;
    if (list.length < MISSING_EDGE_CAP) list.push({ from, to, missing_in: side });
  };
  for (const [u, v] of A.directEdges) {
    if (!B.recorded.has(u) || !B.recorded.has(v)) push(u, v, 'b');
    else if (!reachIdx(B, B.index.get(u), B.index.get(v))) push(u, v, 'b');
  }
  for (const [u, v] of B.directEdges) {
    if (!A.recorded.has(u) || !A.recorded.has(v)) push(u, v, 'a');
    else if (!reachIdx(A, A.index.get(u), A.index.get(v))) push(u, v, 'a');
  }
  list.sort((x, y) => (x.from === y.from ? (x.to < y.to ? -1 : 1) : x.from < y.from ? -1 : 1));
  return { list, total };
}

// Core comparison of two normalized event maps.
export function compareLogs(ea, eb) {
  const A = analyzeEvents(ea);
  const B = analyzeEvents(eb);

  const shared = [];
  for (const id of A.recorded) if (B.recorded.has(id)) shared.push(id);
  shared.sort();

  // 1. state conflicts on shared events -> hard contradiction
  for (const id of shared) {
    const sa = canon(ea.get(id).state);
    const sb = canon(eb.get(id).state);
    if (sa !== sb) {
      return {
        status: 'NOT_EQUAL',
        reason: `state conflict on shared event "${id}"`,
        first_divergent: {
          type: 'state',
          event: id,
          state_a: ea.get(id).state === undefined ? null : ea.get(id).state,
          state_b: eb.get(id).state === undefined ? null : eb.get(id).state,
        },
        minimal_frontier: [],
      };
    }
  }

  // 2. reachability restricted to shared events
  const idxA = shared.map((id) => A.index.get(id));
  const idxB = shared.map((id) => B.index.get(id));
  let nAB = 0;
  let nBA = 0;
  let firstAB = null;
  let firstBA = null;
  for (let i = 0; i < shared.length; i++) {
    for (let j = 0; j < shared.length; j++) {
      const ra = reachIdx(A, idxA[i], idxA[j]);
      const rb = reachIdx(B, idxB[i], idxB[j]);
      if (ra && !rb) {
        nAB++;
        if (!firstAB) firstAB = [shared[i], shared[j]];
      } else if (rb && !ra) {
        nBA++;
        if (!firstBA) firstBA = [shared[i], shared[j]];
      }
    }
  }

  if (nAB > 0 && nBA > 0) {
    // incomparable partial orders -> hard contradiction
    let pair = firstAB;
    let side = 'a';
    if (firstBA && lexPairCmp(firstBA, firstAB) < 0) {
      pair = firstBA;
      side = 'b';
    }
    const reaching = side === 'a' ? A : B;
    return {
      status: 'NOT_EQUAL',
      reason: `incompatible causal order: "${pair[0]}" reaches "${pair[1]}" in log ${side} but not in the other, and vice versa elsewhere`,
      first_divergent: {
        type: 'order',
        pair,
        reachable_in: side,
        missing_in: side === 'a' ? 'b' : 'a',
      },
      minimal_frontier: shortestPathEdges(reaching, pair[0], pair[1]),
    };
  }

  const sameRecorded = A.recorded.size === shared.length && B.recorded.size === shared.length;
  const sameExternals =
    A.externals.length === B.externals.length && A.externals.every((x, i) => x === B.externals[i]);

  if (nAB === 0 && nBA === 0 && sameRecorded && sameExternals) {
    return { status: 'EQUAL' };
  }

  // 3. every difference is explainable by missing information
  const { list, total } = missingEdges(A, B);
  const reasons = [];
  if (nAB > 0) reasons.push(`log a derives ${nAB} order pair(s) that log b cannot`);
  if (nBA > 0) reasons.push(`log b derives ${nBA} order pair(s) that log a cannot`);
  if (!sameRecorded) reasons.push('recorded event sets differ');
  if (!sameExternals) reasons.push('unresolved external references differ');
  return {
    status: 'UNDECIDED',
    reason: reasons.join('; '),
    missing_edges: list,
    missing_edges_total: total,
    truncated: total > list.length,
  };
}

export class Store {
  constructor() {
    this.logs = new Map();
  }

  ingest(logId, events) {
    if (typeof logId !== 'string' || logId.length === 0) return invalid('log_id must be a non-empty string');
    if (this.logs.has(logId)) return invalid(`duplicate log_id: ${logId}`);
    if (!Array.isArray(events)) return invalid('events must be an array');
    const norm = new Map();
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const err = validateEvent(e);
      if (err) return invalid(`event ${i}: ${err}`);
      const preds = [...new Set(e.preds ?? [])];
      const existing = norm.get(e.id);
      if (existing) {
        for (const p of preds) existing.preds.add(p);
        if (e.state !== undefined) {
          if (existing.state !== undefined && canon(existing.state) !== canon(e.state)) {
            return invalid(`event ${i}: conflicting state for duplicate event id "${e.id}"`);
          }
          existing.state = e.state;
        }
      } else {
        norm.set(e.id, { preds: new Set(preds), state: e.state });
      }
    }
    const finalized = new Map();
    for (const [id, ev] of norm) finalized.set(id, { preds: [...ev.preds], state: ev.state });
    this.logs.set(logId, { events: finalized });
    return { status: 'OK', log_id: logId, events: finalized.size };
  }

  merge(newId, ids) {
    if (typeof newId !== 'string' || newId.length === 0) return invalid('new log_id must be a non-empty string');
    if (this.logs.has(newId)) return invalid(`duplicate log_id: ${newId}`);
    if (!Array.isArray(ids) || ids.length === 0) return invalid('merge requires at least one source log_id');
    const combined = new Map();
    for (const id of ids) {
      const log = this.logs.get(id);
      if (!log) return invalid(`unknown log_id: ${id}`);
      for (const [eid, ev] of log.events) {
        const existing = combined.get(eid);
        if (existing) {
          for (const p of ev.preds) existing.preds.add(p);
          if (ev.state !== undefined) {
            if (existing.state !== undefined && canon(existing.state) !== canon(ev.state)) {
              return invalid(`merge conflict: event "${eid}" has different state payloads across logs`, {
                conflicts: [{ event: eid }],
              });
            }
            existing.state = ev.state;
          }
        } else {
          combined.set(eid, { preds: new Set(ev.preds), state: ev.state });
        }
      }
    }
    const finalized = new Map();
    for (const [id, ev] of combined) finalized.set(id, { preds: [...ev.preds], state: ev.state });
    this.logs.set(newId, { events: finalized });
    return { status: 'OK', log_id: newId, events: finalized.size, merged: ids };
  }

  equiv(a, b) {
    const la = this.logs.get(a);
    const lb = this.logs.get(b);
    if (!la) return invalid(`unknown log_id: ${a}`);
    if (!lb) return invalid(`unknown log_id: ${b}`);
    return compareLogs(la.events, lb.events);
  }

  explain(a, b) {
    const la = this.logs.get(a);
    const lb = this.logs.get(b);
    if (!la) return invalid(`unknown log_id: ${a}`);
    if (!lb) return invalid(`unknown log_id: ${b}`);
    const verdict = compareLogs(la.events, lb.events);
    return {
      ...verdict,
      boundary_a: summarize(analyzeEvents(la.events)),
      boundary_b: summarize(analyzeEvents(lb.events)),
    };
  }

  snapshot() {
    const payload = {
      logs: [...this.logs.entries()]
        .map(([id, log]) => ({
          id,
          events: [...log.events.entries()].map(([eid, ev]) => {
            const out = { id: eid, preds: [...ev.preds] };
            if (ev.state !== undefined) out.state = ev.state;
            return out;
          }),
        }))
        .sort((x, y) => (x.id < y.id ? -1 : 1)),
    };
    const checksum = createHash('sha256').update(canon(payload)).digest('hex');
    return JSON.stringify({ magic: MAGIC, version: SNAPSHOT_VERSION, checksum, payload }, null, 2);
  }

  // Atomically replace in-memory state; corrupt input leaves state untouched.
  restoreFrom(text) {
    const r = parseSnapshot(text);
    if (r.error) return { status: 'RESTORE_CORRUPT', error: r.error };
    this.logs = r.logs;
    return { status: 'OK', logs: r.logs.size };
  }

  static restore(text) {
    const r = parseSnapshot(text);
    if (r.error) return { status: 'RESTORE_CORRUPT', error: r.error };
    const store = new Store();
    store.logs = r.logs;
    return { status: 'OK', store };
  }
}

function parseSnapshot(text) {
  if (typeof text !== 'string') return { error: 'snapshot must be a string' };
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { error: 'invalid JSON' };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return { error: 'snapshot is not an object' };
  if (doc.magic !== MAGIC) return { error: 'bad magic' };
  if (doc.version !== SNAPSHOT_VERSION) return { error: 'unsupported version' };
  if (typeof doc.checksum !== 'string') return { error: 'missing checksum' };
  let body;
  try {
    body = canon(doc.payload);
  } catch {
    return { error: 'payload not serializable' };
  }
  const sum = createHash('sha256').update(body).digest('hex');
  if (sum !== doc.checksum) return { error: 'checksum mismatch' };
  const p = doc.payload;
  if (p === null || typeof p !== 'object' || !Array.isArray(p.logs)) return { error: 'bad payload' };
  const logs = new Map();
  for (const entry of p.logs) {
    if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string' || entry.id.length === 0) {
      return { error: 'bad log entry' };
    }
    if (logs.has(entry.id)) return { error: 'duplicate log_id in snapshot' };
    if (!Array.isArray(entry.events)) return { error: 'bad events array' };
    const norm = new Map();
    for (const e of entry.events) {
      const err = validateEvent(e);
      if (err) return { error: `log "${entry.id}": ${err}` };
      if (norm.has(e.id)) return { error: `log "${entry.id}": duplicate event id "${e.id}"` };
      norm.set(e.id, { preds: [...new Set(e.preds ?? [])], state: e.state });
    }
    logs.set(entry.id, { events: norm });
  }
  return { logs };
}
