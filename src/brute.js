'use strict';

// Brute-force reference implementation used by the conformance tests:
// enumerates every linearization (topological order) of an account's poset
// and groups them by their per-op verdict vector. Exponential — only for
// small n (tests use n <= 8).

const { AccountState } = require('./sim');
const { buildPoset, canonicalOrder } = require('./judge');

function bruteForceGroups(ops, config = {}) {
  const poset = buildPoset(ops);
  const { order, cyclic } = canonicalOrder(ops, poset);
  const byId = new Map(ops.map((o) => [o.opId, o]));
  const groups = new Map(); // verdictKey -> { verdicts: Map, sequences: [] }

  const indeg = new Map(poset.indeg);
  const ready = [];
  for (const id of order) if (indeg.get(id) === 0) ready.push(id);

  function dfs(readyArr, state, prefix, verdicts) {
    if (prefix.length === order.length) {
      const key = order.map((id) => verdicts.get(id)).join(',');
      if (!groups.has(key)) groups.set(key, { sequences: [] });
      groups.get(key).sequences.push(prefix.slice());
      return;
    }
    for (let i = 0; i < readyArr.length; i++) {
      const id = readyArr[i];
      const nextState = state.clone();
      const code = nextState.apply(byId.get(id));
      verdicts.set(id, code);
      const promoted = [];
      for (const nxt of poset.adj.get(id)) {
        indeg.set(nxt, indeg.get(nxt) - 1);
        if (indeg.get(nxt) === 0) promoted.push(nxt);
      }
      const nextReady = readyArr.slice(0, i).concat(readyArr.slice(i + 1), promoted);
      prefix.push(id);
      dfs(nextReady, nextState, prefix, verdicts);
      prefix.pop();
      for (const nxt of poset.adj.get(id)) indeg.set(nxt, indeg.get(nxt) + 1);
    }
  }

  dfs(ready, new AccountState(config), [], new Map());
  return { groups, canonicalSeq: order, cyclic };
}

module.exports = { bruteForceGroups };
