import { createState, stateKey, step } from './model.js';

// Enumerate candidate linearizations of `ops` (<= 12 operations).
//
// A permutation is a candidate linearization iff:
//   - it preserves real-time order (a.respond <= b.invoke  =>  a before b);
//   - linearization points lie within [invoke, respond] (greedy earliest
//     points are componentwise minimal, so they exist iff the greedy
//     assignment stays within every interval);
//   - replaying the state machine reproduces every recorded response,
//     choosing for each capture an allocation consistent with the
//     cumulative total reported at its response time.
//
// Returns up to `limit` witnesses.
export function findWitnesses(ops, { limit = 1 } = {}) {
  const n = ops.length;
  const pred = new Array(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if (i !== j && ops[i].respond <= ops[j].invoke) pred[j] |= 1 << i;
    }
  }

  const witnesses = [];
  // failed: map from (usedMask, stateKey) to the smallest frontier time
  // already proven infeasible. Larger frontier times are dominated because
  // every remaining constraint is an upper bound on the linearization point.
  const failed = new Map();
  const perm = [];
  const points = [];
  const effects = [];

  function buildWitness() {
    const order = perm.map((i) => ops[i].id);
    const pointMap = {};
    const allocations = {};
    const audits = {};
    perm.forEach((opIndex, position) => {
      const op = ops[opIndex];
      pointMap[op.id] = points[position];
      const effect = effects[position];
      if (op.op === 'capture' && op.response.ok) allocations[op.id] = effect.allocation;
      if (op.op === 'audit' && op.response.ok) audits[op.id] = effect.observed;
    });
    return { order, points: pointMap, allocations, audits };
  }

  function visit(state, used, frontier) {
    if (witnesses.length >= limit) return;
    if (perm.length === n) {
      witnesses.push(buildWitness());
      return;
    }
    const key = `${used}|${stateKey(state)}`;
    const bound = failed.get(key);
    if (bound !== undefined && frontier >= bound) return;
    const foundBefore = witnesses.length;
    for (let i = 0; i < n; i += 1) {
      if (used & (1 << i)) continue;
      if (pred[i] & ~used) continue;
      const point = Math.max(ops[i].invoke, frontier);
      if (point > ops[i].respond) continue;
      const result = step(state, ops[i], point);
      if (!result) continue;
      perm.push(i);
      points.push(point);
      effects.push(result.effect);
      visit(result.state, used | (1 << i), point);
      perm.pop();
      points.pop();
      effects.pop();
      if (witnesses.length >= limit) return;
    }
    // Only memoize genuine failures: configurations whose entire subtree
    // produced no witness. Monotonicity (all remaining constraints are
    // upper bounds on the frontier) makes larger frontiers dominated.
    if (witnesses.length === foundBefore && (bound === undefined || frontier < bound)) {
      failed.set(key, frontier);
    }
  }

  visit(createState(), 0, -Infinity);
  return witnesses;
}

export function isLinearizable(ops) {
  return findWitnesses(ops, { limit: 1 }).length > 0;
}
