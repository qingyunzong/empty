'use strict';

const { listNodes, computeNode, byRankThenId } = require('./derive');

// Reference implementation: recompute every node from scratch in
// topological (rank) order. Used by tests to validate the incremental
// engine against full enumeration.
function fullRecompute(state) {
  const outputs = new Map();
  for (const id of listNodes(state).sort(byRankThenId)) {
    outputs.set(id, computeNode(id, state, (d) => outputs.get(d)));
  }
  return outputs;
}

module.exports = { fullRecompute };
