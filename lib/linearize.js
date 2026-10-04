'use strict';

// Linearization certificate for a concurrent history.
//
// Nodes are accepted client ops (ledger events carrying an idem key).
// Edges are real dependencies: an op that references another op (capture ->
// auth, refund/reversal/void -> target) must come after it. Any topological
// order of this graph is an acceptable serial explanation of the history.
// Returns {linearizable: true, order} or {linearizable: false, reason}.
function linearize(ledger) {
  const nodes = [];
  const deps = new Map();
  const seen = new Set();
  for (const ev of ledger) {
    if (!ev.idem || seen.has(ev.idem)) continue;
    seen.add(ev.idem);
    nodes.push(ev.idem);
    const d = new Set();
    if (ev.ref && seen.has(ev.ref)) d.add(ev.ref);
    deps.set(ev.idem, d);
  }
  const order = [];
  const done = new Set();
  const remaining = new Map(deps);
  while (remaining.size > 0) {
    const next = nodes.find(
      (n) => remaining.has(n) && [...remaining.get(n)].every((d) => done.has(d))
    );
    if (next === undefined) {
      return {
        linearizable: false,
        reason: `dependency cycle among: ${[...remaining.keys()].join(', ')}`,
      };
    }
    order.push(next);
    done.add(next);
    remaining.delete(next);
  }
  return { linearizable: true, order };
}

module.exports = { linearize };
