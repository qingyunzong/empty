// Core CRDT state for offline OEE collection.
//
// State = grow-only event journal + materialized hold set; all views
// (PN-Counters, downtime set, tombstones) are deterministic folds of the
// journal. Merge is therefore set-union plus a deterministic derive, which
// makes it idempotent, commutative, and associative by construction.
//
//   counters:   name -> node -> {p, n}   PN-Counter view (p=inc, n=dec)
//   downtimes:  id -> {id,start,end,node} revocable intervals, remove-wins
//   tombstones: id -> true               revoked downtime ids
//   holds:      id -> event              out-of-clock-bound events (never applied)
//   journal:    id -> event              grow-only set (drives anti-entropy)

export class NegativeCountError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NegativeCountError';
    this.code = 'ERR_NEGATIVE_COUNT';
  }
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'ERR_VALIDATION';
  }
}

export function emptyState() {
  return { version: 1, counters: {}, downtimes: {}, tombstones: {}, holds: {}, journal: {} };
}

export function eventTs(event) {
  if (typeof event.ts === 'number') return event.ts;
  if (event.type === 'downtime' && typeof event.start === 'number') return event.start;
  return undefined;
}

export function validateEvent(event) {
  if (event === null || typeof event !== 'object') throw new ValidationError('event must be an object');
  if (typeof event.id !== 'string' || event.id === '') throw new ValidationError('event.id must be a non-empty string');
  switch (event.type) {
    case 'count':
      if (typeof event.counter !== 'string' || event.counter === '') throw new ValidationError('count.counter required');
      if (typeof event.node !== 'string' || event.node === '') throw new ValidationError('count.node required');
      if (typeof event.delta !== 'number' || !Number.isFinite(event.delta)) throw new ValidationError('count.delta must be a finite number');
      break;
    case 'downtime':
      if (typeof event.node !== 'string' || event.node === '') throw new ValidationError('downtime.node required');
      if (typeof event.start !== 'number' || typeof event.end !== 'number' || !(event.start < event.end)) {
        throw new ValidationError('downtime requires start < end');
      }
      break;
    case 'revoke':
      if (typeof event.target !== 'string' || event.target === '') throw new ValidationError('revoke.target required');
      break;
    default:
      throw new ValidationError(`unknown event type: ${String(event.type)}`);
  }
  return event;
}

function isOutOfWindow(event, opts) {
  if (opts.windowStart === undefined || opts.windowEnd === undefined) return false;
  const ts = eventTs(event);
  if (ts === undefined) return false;
  const skew = opts.maxSkew ?? 0;
  return ts < opts.windowStart - skew || ts > opts.windowEnd + skew;
}

// Recompute all derived views from journal + holds. Deterministic and
// order-independent, which is what makes shard merges exactly equal.
export function derive(state) {
  const counters = {};
  const tombstones = {};
  const downtimes = {};
  for (const event of Object.values(state.journal)) {
    if (state.holds[event.id]) continue; // held events never apply
    if (event.type === 'revoke') tombstones[event.target] = true;
  }
  for (const event of Object.values(state.journal)) {
    if (state.holds[event.id]) continue;
    if (event.type === 'count') {
      const nodes = (counters[event.counter] ??= {});
      const pn = (nodes[event.node] ??= { p: 0, n: 0 });
      if (event.delta >= 0) pn.p += event.delta;
      else pn.n += -event.delta;
    } else if (event.type === 'downtime' && !tombstones[event.id]) {
      downtimes[event.id] = {
        id: event.id,
        start: event.start,
        end: event.end,
        node: event.node,
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
      };
    }
  }
  state.counters = counters;
  state.downtimes = downtimes;
  state.tombstones = tombstones;
  for (const [name, nodes] of Object.entries(counters)) {
    if (counterTotalObj(nodes) < 0) {
      throw new NegativeCountError(`counter "${name}" is negative (${counterTotalObj(nodes)})`);
    }
  }
  return state;
}

function counterTotalObj(nodes) {
  let total = 0;
  for (const pn of Object.values(nodes)) total += pn.p - pn.n;
  return total;
}

export function counterTotal(state, name) {
  const nodes = state.counters[name];
  return nodes ? counterTotalObj(nodes) : 0;
}

// Apply one event. Out-of-bound events are diverted to `holds` and never
// contribute to counters, downtime, or violations. Re-ingest is a no-op.
export function applyEvent(state, rawEvent, opts = {}) {
  const event = validateEvent(rawEvent);
  if (state.journal[event.id]) return state;
  if (isOutOfWindow(event, opts)) {
    state.holds[event.id] = { ...event, holdReason: 'out-of-clock-bound' };
  }
  state.journal[event.id] = event;
  try {
    derive(state);
  } catch (err) {
    delete state.journal[event.id];
    delete state.holds[event.id];
    derive(state);
    throw err;
  }
  return state;
}

export function mergeStates(a, b) {
  const out = emptyState();
  out.journal = { ...a.journal, ...b.journal };
  out.holds = { ...a.holds, ...b.holds };
  return derive(out);
}

export function mergeAll(states) {
  return states.reduce((acc, s) => mergeStates(acc, s), emptyState());
}

// Merge overlapping/adjacent downtime intervals into a disjoint cover.
export function mergedIntervals(state) {
  const ivs = Object.values(state.downtimes)
    .map((d) => [d.start, d.end])
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out = [];
  for (const [s, e] of ivs) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

export function downtimeTotal(state, windowStart, windowEnd) {
  let total = 0;
  for (const [s, e] of mergedIntervals(state)) {
    const cs = windowStart !== undefined ? Math.max(s, windowStart) : s;
    const ce = windowEnd !== undefined ? Math.min(e, windowEnd) : e;
    if (ce > cs) total += ce - cs;
  }
  return total;
}

export function pendingHolds(state) {
  return Object.values(state.holds)
    .map((e) => ({ id: e.id, type: e.type, reason: e.holdReason, ts: eventTs(e) ?? null }))
    .sort((x, y) => (x.id < y.id ? -1 : 1));
}

// Deterministic serialization for equality checks across merge orders.
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k]);
    return out;
  }
  return value;
}

export function canonicalState(state) {
  return JSON.stringify(canonicalize(state));
}

// Observable projection (everything except the raw journal).
export function observable(state) {
  return canonicalize({
    counters: state.counters,
    downtimes: state.downtimes,
    tombstones: state.tombstones,
    holds: state.holds,
  });
}
