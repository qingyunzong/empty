'use strict';

// Bytes a (re)completion of `n` would still charge to its owner's quota.
// Nodes already present in the ledger were charged once and never again,
// so recomputation after invalidation/preemption is quota-free.
function chargeOf(state, n) {
  return state.ledger[n.id] != null ? 0 : n.bytes;
}

// Compute the maximum set of not-yet-done nodes that can still be completed:
// dependency-closed (deps done or inside the set) and quota-feasible per
// owner. Exact enumeration for small frontiers; returns null for large ones
// (the scheduler then falls back to online greedy admission).
function planTarget(state, { maxExact = 12, maxRetries = 3 } = {}) {
  const nodes = state.nodes;
  const cand = Object.values(nodes).filter(
    (n) => n.status !== 'done' && (n.fails ?? 0) < maxRetries,
  );
  if (cand.length === 0) return new Set();
  if (cand.length > maxExact) return null;

  const ids = cand.map((n) => n.id);
  const m = ids.length;
  let best = null;
  let bestCount = -1;
  let bestBytes = -1;
  for (let mask = 0; mask < 2 ** m; mask += 1) {
    const inS = new Set();
    for (let i = 0; i < m; i += 1) if (mask & (1 << i)) inS.add(ids[i]);
    let ok = true;
    let count = 0;
    let bytes = 0;
    const perOwner = {};
    for (const id of inS) {
      const n = nodes[id];
      for (const d of n.deps) {
        if (nodes[d].status !== 'done' && !inS.has(d)) {
          ok = false;
          break;
        }
      }
      if (!ok) break;
      perOwner[n.owner] = (perOwner[n.owner] ?? 0) + chargeOf(state, n);
      count += 1;
      bytes += n.bytes;
    }
    if (!ok) continue;
    for (const [owner, sum] of Object.entries(perOwner)) {
      const quota = state.quotas[owner] ?? Infinity;
      if ((state.completedBytes[owner] ?? 0) + sum > quota) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (count > bestCount || (count === bestCount && bytes > bestBytes)) {
      bestCount = count;
      bestBytes = bytes;
      best = inS;
    }
  }
  return best ?? new Set();
}

module.exports = { planTarget, chargeOf };
