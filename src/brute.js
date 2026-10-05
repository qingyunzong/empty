'use strict';
// Brute-force reference implementation: enumerates EVERY topological order of
// the per-account causal DAG, evaluates greedily, and collects all optimal
// outcomes. Feasible only for small n (used by tests for n <= 8); serves as
// the ground-truth oracle for src/judge.js.
const {
  buildGraph,
  applyOp,
  cloneState,
  scoreCompare,
  finalizeOutcome,
} = require('./judge');

function bruteForceAccount(entries, cfg) {
  const { ops, predMask } = buildGraph(entries);
  const n = ops.length;
  const FULL = (1n << BigInt(n)) - 1n;
  let bestScore = null;
  const outcomes = new Map(); // signature -> outcome
  const codes = new Array(n);
  const order = [];

  function rec(mask, st) {
    if (mask === FULL) {
      const arr = order.map((i) => [i, codes[i]]);
      const o = finalizeOutcome(ops, cfg, arr);
      if (bestScore === null || scoreCompare(o.score, bestScore) > 0) {
        bestScore = o.score;
        outcomes.clear();
        outcomes.set(o.signature, o);
      } else if (scoreCompare(o.score, bestScore) === 0) {
        outcomes.set(o.signature, o);
      }
      return;
    }
    for (let i = 0; i < n; i++) {
      const bit = 1n << BigInt(i);
      if (mask & bit) continue;
      if ((predMask[i] & ~mask) !== 0n) continue;
      const st2 = cloneState(st);
      const code = applyOp(ops[i], entries[i].dup, st2, cfg);
      codes[i] = code;
      order.push(i);
      rec(mask | bit, st2);
      order.pop();
      codes[i] = undefined;
    }
  }

  rec(0n, { available: cfg.creditLimit, budgets: new Map(), freezes: new Map() });
  const list = [...outcomes.values()].sort((a, b) => (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0));
  return { available: list[0].available, score: bestScore, outcomes: list, truncated: false };
}

module.exports = { bruteForceAccount };
