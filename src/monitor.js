'use strict';

const { buildDFA, step } = require('./regex');
const { MonitorError } = require('./errors');

const VIOLATION = 'VIOLATION';
const SAFE = 'SAFE';
const UNKNOWN = 'UNKNOWN';

// Upper bound on the number of count vectors explored by the exact
// macro-step analysis (product of per-type counts + 1). Macro-steps are
// simultaneous-event batches and are expected to be small; the acceptance
// cross-check covers n <= 7 (at most 2^7 = 128 vectors).
const MAX_VECTORS = 2000000;

// Fixed tie-break ordering for simultaneous events: numeric ids first in
// numeric order, then string ids in code-unit order.
function compareIds(a, b) {
  const aNum = typeof a.id === 'number';
  const bNum = typeof b.id === 'number';
  if (aNum && bNum) return a.id - b.id;
  if (aNum) return -1;
  if (bNum) return 1;
  const sa = String(a.id);
  const sb = String(b.id);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function validateEvents(events) {
  if (!Array.isArray(events)) {
    throw new MonitorError('BAD_INPUT', 'batch events must be an array');
  }
  const seen = new Set();
  for (const e of events) {
    if (!e || typeof e !== 'object' || e.id === undefined || e.id === null ||
        (typeof e.id !== 'string' && typeof e.id !== 'number') ||
        typeof e.type !== 'string' || e.type === '') {
      throw new MonitorError('BAD_INPUT', `invalid event record: ${JSON.stringify(e)}`);
    }
    const key = String(e.id);
    if (seen.has(key)) {
      throw new MonitorError('DUP_ID', `duplicate event id in macro-step: ${key}`);
    }
    seen.add(key);
  }
}

// Exact set of DFA states reachable from `startSet` after consuming the
// event-type multiset `types` in any order. Dynamic programming over count
// vectors: dp[v] = set of states reachable after consuming exactly v[i]
// events of distinct type i.
function stepMultiset(dfa, startSet, types) {
  const distinct = [...new Set(types)];
  const indexOf = new Map(distinct.map((t, i) => [t, i]));
  const maxCount = distinct.map(() => 0);
  for (const t of types) maxCount[indexOf.get(t)]++;

  let total = 1;
  for (const c of maxCount) total *= (c + 1);
  if (total > MAX_VECTORS) {
    throw new MonitorError(
      'BATCH_TOO_COMPLEX',
      `macro-step ambiguity analysis needs ${total} count vectors (limit ${MAX_VECTORS}); split the batch`,
    );
  }

  const keyOf = (vec) => vec.join(',');
  const dp = new Map();
  const zero = distinct.map(() => 0);
  dp.set(keyOf(zero), new Set(startSet));

  // Generate all count vectors grouped by their sum, ascending.
  const bySum = [];
  const vec = zero.slice();
  (function gen(i) {
    if (i === distinct.length) {
      const sum = vec.reduce((a, b) => a + b, 0);
      if (sum > 0) {
        (bySum[sum] = bySum[sum] || []).push(vec.slice());
      }
      return;
    }
    for (let c = 0; c <= maxCount[i]; c++) {
      vec[i] = c;
      gen(i + 1);
    }
    vec[i] = 0;
  })(0);

  for (const group of bySum) {
    if (!group) continue;
    for (const v of group) {
      const acc = new Set();
      for (let i = 0; i < distinct.length; i++) {
        if (v[i] === 0) continue;
        v[i]--;
        const prev = dp.get(keyOf(v));
        v[i]++;
        for (const s of prev) acc.add(step(dfa, s, distinct[i]));
      }
      dp.set(keyOf(v), acc);
    }
  }

  return dp.get(keyOf(maxCount));
}

// Reference implementation used by the cross-check tests: enumerates every
// distinct permutation of the batch explicitly. Only suitable for small n.
function stepMultisetBrute(dfa, startSet, types) {
  const distinct = [...new Set(types)];
  const indexOf = new Map(distinct.map((t, i) => [t, i]));
  const remaining = distinct.map(() => 0);
  for (const t of types) remaining[indexOf.get(t)]++;

  const result = new Set();
  (function rec(states) {
    let any = false;
    for (let i = 0; i < distinct.length; i++) {
      if (remaining[i] === 0) continue;
      any = true;
      remaining[i]--;
      const next = new Set();
      for (const s of states) next.add(step(dfa, s, distinct[i]));
      rec(next);
      remaining[i]++;
    }
    if (!any) {
      for (const s of states) result.add(s);
    }
  })(new Set(startSet));
  return result;
}

class Monitor {
  constructor(pattern, snapshot) {
    this.dfa = buildDFA(pattern);
    if (snapshot) {
      this.possible = new Set(snapshot.states);
      this.ambiguousEver = Boolean(snapshot.ambiguous);
    } else {
      this.possible = new Set([this.dfa.start]);
      this.ambiguousEver = false;
    }
  }

  snapshot() {
    return {
      states: [...this.possible].sort((a, b) => a - b),
      ambiguous: this.ambiguousEver,
    };
  }

  verdictOfState(stateId) {
    if (this.dfa.accept.has(stateId)) return VIOLATION;
    if (this.dfa.dead.has(stateId)) return SAFE;
    return UNKNOWN;
  }

  // Three-valued verdict over the set of possible DFA states:
  //   VIOLATION  some reachable state is accepting (conservative alarm;
  //              accepting states are sinks, so this is irreversible)
  //   SAFE       every reachable state is dead (no order and no extension
  //              can ever produce a violation)
  //   UNKNOWN    otherwise -- never reported as SAFE and never as UNSAT
  verdict() {
    let sawUnknown = false;
    for (const s of this.possible) {
      const v = this.verdictOfState(s);
      if (v === VIOLATION) return VIOLATION;
      if (v === UNKNOWN) sawUnknown = true;
    }
    return sawUnknown ? UNKNOWN : SAFE;
  }

  // Consume one macro-step (a batch of simultaneous events). Returns the
  // tie-break order used for the WAL record and whether the conclusion
  // depends on the intra-batch order.
  applyBatch(events) {
    validateEvents(events);
    const ordered = [...events].sort(compareIds);
    const types = ordered.map((e) => e.type);
    const next = stepMultiset(this.dfa, this.possible, types);
    const verdicts = new Set([...next].map((s) => this.verdictOfState(s)));
    const ambiguous = verdicts.size > 1;
    if (ambiguous) this.ambiguousEver = true;
    this.possible = next;
    return { ambiguous, order: ordered.map((e) => e.id) };
  }
}

module.exports = {
  Monitor,
  VIOLATION,
  SAFE,
  UNKNOWN,
  compareIds,
  validateEvents,
  stepMultiset,
  stepMultisetBrute,
};
