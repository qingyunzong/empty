'use strict';

const crypto = require('crypto');
const { RegexMonitor } = require('./regex');

const EXIT_CONSISTENCY = 12;
// Full permutation enumeration is exact up to this batch size (8! = 40320).
const FULL_ENUM_MAX = 8;
const SAMPLE_COUNT = 512;

class MonitorError extends Error {
  constructor(message, code = EXIT_CONSISTENCY) {
    super(message);
    this.name = 'MonitorError';
    this.code = code;
  }
}

function stateHash(seq, dfaKey, violation, ambiguous) {
  const payload = JSON.stringify({ seq, dfaKey, violation, ambiguous });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

// Fixed tie-break for simultaneous events: ascending by id.
function cmpIds(a, b) {
  if (typeof a === typeof b) return a < b ? -1 : a > b ? 1 : 0;
  const sa = String(a); const sb = String(b);
  return sa < sb ? -1 : 1;
}

function* heapPermutations(arr) {
  const n = arr.length;
  if (n <= 1) { yield arr.slice(); return; }
  const a = arr.slice();
  const c = new Array(n).fill(0);
  yield a.slice();
  let i = 0;
  while (i < n) {
    if (c[i] < i) {
      const j = i % 2 === 0 ? 0 : c[i];
      const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
      yield a.slice();
      c[i]++; i = 0;
    } else {
      c[i] = 0; i++;
    }
  }
}

// Deterministic sample of orders for batches too large to enumerate fully:
// canonical, reversed, rotations, then a fixed-seed LCG shuffle.
function* sampledOrders(events, canonical) {
  const n = events.length;
  yield canonical.slice();
  yield canonical.slice().reverse();
  for (let r = 1; r < n; r++) yield canonical.slice(r).concat(canonical.slice(0, r));
  let seed = 0x9e3779b9;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  let produced = n + 1;
  while (produced < SAMPLE_COUNT) {
    const a = canonical.slice();
    for (let i = n - 1; i > 0; i--) {
      const j = next() % (i + 1);
      const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    yield a;
    produced++;
  }
}

class SafetyMonitor {
  constructor(pattern) {
    this.re = new RegexMonitor(pattern);
    this.dfaKey = this.re.initial;
    this.violation = false; // sticky: once confirmed, never revoked
    this.ambiguous = false; // sticky: once any macro-step is order-sensitive
    this.seq = 0;
  }

  triState() {
    if (this.violation) return 'VIOLATION';
    // UNKNOWN is never reported as SAFE/UNSAT: reachability decides.
    return this.re.canReachAccept(this.dfaKey) ? 'UNKNOWN' : 'SAFE';
  }

  hash() {
    return stateHash(this.seq, this.dfaKey, this.violation, this.ambiguous);
  }

  snapshot() {
    return { dfaKey: this.dfaKey, violation: this.violation, ambiguous: this.ambiguous, seq: this.seq };
  }

  restore(snap) {
    this.dfaKey = snap.dfaKey;
    this.violation = snap.violation;
    this.ambiguous = snap.ambiguous;
    this.seq = snap.seq;
  }

  applyEvent(name) {
    this.dfaKey = this.re.move(this.dfaKey, name);
    if (this.re.isAccept(this.dfaKey)) this.violation = true;
  }

  // Simulate one intra-batch order on a temporary copy of the state.
  simulateOrder(events) {
    const snap = this.snapshot();
    for (const e of events) this.applyEvent(e.name);
    const tri = this.triState();
    this.restore(snap);
    return tri;
  }

  // A macro-step: simultaneous events ordered by the fixed tie-break.
  // If any other order would reach a different conclusion, flag ambiguity.
  applyBatch(events) {
    if (!Array.isArray(events)) throw new MonitorError('batch.events must be an array');
    const seen = new Set();
    for (const e of events) {
      if (e === null || typeof e !== 'object' || e.id === undefined || typeof e.name !== 'string') {
        throw new MonitorError('every event needs an id and a string name');
      }
      if (seen.has(e.id)) throw new MonitorError(`duplicate event id in macro-step: ${JSON.stringify(e.id)}`);
      seen.add(e.id);
    }
    const canonical = events.slice().sort((x, y) => cmpIds(x.id, y.id));

    if (events.length > 1) {
      const outcomes = new Set();
      if (events.length <= FULL_ENUM_MAX) {
        for (const perm of heapPermutations(events)) outcomes.add(this.simulateOrder(perm));
      } else {
        for (const order of sampledOrders(events, canonical)) outcomes.add(this.simulateOrder(order));
      }
      if (outcomes.size > 1) this.ambiguous = true;
    }

    for (const e of canonical) this.applyEvent(e.name);
    this.seq += 1;
    return { seq: this.seq, hash: this.hash() };
  }

  status() {
    return { state: this.triState(), ambiguous: this.ambiguous, seq: this.seq, hash: this.hash() };
  }
}

module.exports = {
  SafetyMonitor,
  MonitorError,
  stateHash,
  cmpIds,
  heapPermutations,
  EXIT_CONSISTENCY,
  FULL_ENUM_MAX,
};
