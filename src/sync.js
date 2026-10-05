'use strict';
const { applyOps, compareOps } = require('./core.js');

// Ops the receiver has not seen yet, per its version vector.
function incoming(fromState, vv) {
  return fromState.ops.concat(fromState.pending)
    .filter((op) => (vv[op.node] || 0) < op.seq)
    .sort(compareOps);
}

function mergeInto(state, ops) {
  if (ops.length === 0 && state.pending.length === 0) return { received: 0, pending: state.pending.length };
  for (const op of ops) {
    state.vv[op.node] = Math.max(state.vv[op.node] || 0, op.seq);
  }
  const res = applyOps(state.inventory, state.pending.concat(ops));
  const known = new Set(state.ops.map((o) => o.opId));
  for (const op of res.applied) {
    if (!known.has(op.opId)) state.ops.push(op);
  }
  state.pending = res.pending;
  return { received: ops.length, pending: state.pending.length };
}

// Bidirectional convergence between two nodes' data dirs.
// Concurrent adjusts on the same item commute (integer deltas); a merge that
// would go negative is parked in pending, never failed.
function sync(storeA, storeB) {
  storeA.requireInit();
  storeB.requireInit();
  const a = storeA.loadState();
  const b = storeB.loadState();
  const toA = incoming(b, a.vv);
  const toB = incoming(a, b.vv);
  const ra = mergeInto(a, toA);
  const rb = mergeInto(b, toB);
  storeA.saveState(a);
  storeB.saveState(b);
  return {
    nodes: [a.nodeId, b.nodeId],
    received: { [a.nodeId]: ra.received, [b.nodeId]: rb.received },
    pending: { [a.nodeId]: ra.pending, [b.nodeId]: rb.pending },
  };
}

module.exports = { sync, incoming, mergeInto };
