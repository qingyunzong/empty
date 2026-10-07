// Independent proof-tree checker. Replays the search tree produced by
// solve() and verifies:
//   - every internal node splits the first non-fixed variable (ascending
//     order id) and its children exactly cover the variable's domain,
//     disjointly and in ascending order;
//   - propagated bounds / volume upper bound / spend lower bound recorded
//     at each node match an independent recomputation;
//   - every prune leaf carries a reason that is valid at that point of the
//     traversal (flow/funds infeasibility, volume bound, spend bound);
//   - every solution leaf is a feasible fill vector with the stated
//     objective values;
//   - the aggregated optimum, tie count and lexicographically minimal
//     vector match the reported result.

import { frac, add, mul, cmp, eq, ZERO } from './fraction.js';
import { buildContext, propagate } from './solver.js';

function lexLess(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return false;
}

export function verify(problem, result) {
  if (!result || result.status !== 'OK') {
    return { ok: false, error: 'E_STATUS', detail: 'result is not OK' };
  }
  if (!result.proof) {
    return { ok: false, error: 'E_NO_PROOF', detail: 'result carries no proof tree' };
  }
  const ctx = buildContext(problem);
  const n = ctx.n;
  let best = null;
  let count = 0n;
  let lexMin = null;
  let nodes = 0;

  const fail = (error, nodeId, detail) => ({ ok: false, error, nodeId, detail });

  function visit(node, lo, hi) {
    nodes += 1;
    if (!node || typeof node !== 'object') return fail('E_NODE', null, 'missing node');
    const res = propagate(ctx, lo, hi);
    if (!res.ok) {
      if (node.leaf !== 'pruned' || node.reason !== res.reason) {
        return fail('E_PRUNE_REASON', node.id, `expected prune ${res.reason}`);
      }
      return null;
    }
    // Bounds recorded at the node must match the recomputed propagation.
    if (!node.bounds || !Array.isArray(node.bounds.lo) || !Array.isArray(node.bounds.hi)) {
      return fail('E_BOUNDS', node.id, 'missing bounds');
    }
    for (let j = 0; j < n; j++) {
      if (node.bounds.lo[j] !== lo[j] || node.bounds.hi[j] !== hi[j]) {
        return fail('E_BOUNDS', node.id, `bounds mismatch at var ${j}`);
      }
    }
    if (node.volumeUB !== res.volumeUB) return fail('E_BOUND', node.id, 'volumeUB mismatch');
    if (!node.spendLB || !eq(node.spendLB, res.spendLB)) {
      return fail('E_BOUND', node.id, 'spendLB mismatch');
    }
    if (best && res.volumeUB < best.volume) {
      if (node.leaf !== 'pruned' || node.reason !== 'volume_bound') {
        return fail('E_PRUNE_REASON', node.id, 'expected volume_bound prune');
      }
      return null;
    }
    if (best && res.volumeUB === best.volume && cmp(res.spendLB, best.spend) > 0) {
      if (node.leaf !== 'pruned' || node.reason !== 'spend_bound') {
        return fail('E_PRUNE_REASON', node.id, 'expected spend_bound prune');
      }
      return null;
    }
    let fixed = 0;
    for (let j = 0; j < n; j++) if (lo[j] === hi[j]) fixed += 1;
    if (fixed === n) {
      if (node.leaf !== 'solution') return fail('E_LEAF', node.id, 'expected solution leaf');
      let volume = 0n;
      let spend = ZERO;
      for (let j = 0; j < n; j++) {
        if (ctx.vars[j].side === 'buy') {
          volume += lo[j];
          spend = add(spend, mul(ctx.vars[j].price, frac(lo[j])));
        }
      }
      if (node.volume !== volume) return fail('E_LEAF_VALUE', node.id, 'volume mismatch');
      if (!node.spend || !eq(node.spend, spend)) {
        return fail('E_LEAF_VALUE', node.id, 'spend mismatch');
      }
      if (!Array.isArray(node.vector)) return fail('E_LEAF_VALUE', node.id, 'missing vector');
      for (let j = 0; j < n; j++) {
        if (node.vector[j] !== lo[j]) return fail('E_LEAF_VALUE', node.id, 'vector mismatch');
      }
      if (!best || volume > best.volume || (volume === best.volume && cmp(spend, best.spend) < 0)) {
        best = { volume, spend };
        count = 1n;
        lexMin = lo.slice();
      } else if (volume === best.volume && cmp(spend, best.spend) === 0) {
        count += 1n;
        if (lexLess(lo, lexMin)) lexMin = lo.slice();
      }
      return null;
    }
    // Internal node: verify the split covers the domain exactly.
    let split = 0;
    while (lo[split] === hi[split]) split += 1;
    if (node.split !== ctx.vars[split].id) {
      return fail('E_SPLIT_VAR', node.id, 'split variable mismatch');
    }
    if (!Array.isArray(node.children)) return fail('E_SPLIT', node.id, 'missing children');
    const width = hi[split] - lo[split] + 1n;
    if (BigInt(node.children.length) !== width) {
      return fail('E_SPLIT_COVER', node.id, 'children do not cover the domain');
    }
    let expected = lo[split];
    for (const child of node.children) {
      if (
        !child.fix ||
        child.fix.var !== node.split ||
        child.fix.value !== expected
      ) {
        return fail('E_SPLIT_COVER', node.id, 'child does not match expected domain value');
      }
      const clo = lo.slice();
      const chi = hi.slice();
      clo[split] = expected;
      chi[split] = expected;
      const err = visit(child, clo, chi);
      if (err) return err;
      expected += 1n;
    }
    return null;
  }

  const lo0 = new Array(n).fill(0n);
  const hi0 = ctx.vars.map((v) => v.qty);
  const err = visit(result.proof, lo0, hi0);
  if (err) return err;

  // Aggregate objectives must match the reported result.
  if (best === null) {
    if (result.count !== 0n) return fail('E_RESULT', null, 'infeasible but count != 0');
  } else {
    if (result.volume !== best.volume) return fail('E_RESULT', null, 'volume mismatch');
    if (!eq(result.spend, best.spend)) return fail('E_RESULT', null, 'spend mismatch');
    if (result.count !== count) return fail('E_RESULT', null, 'tie count mismatch');
  }
  const vector = {};
  for (const o of problem.orders) vector[String(o.id)] = 0n;
  if (lexMin) {
    for (let j = 0; j < n; j++) vector[ctx.vars[j].id] = lexMin[j];
  }
  for (const [k, v] of Object.entries(vector)) {
    if (result.vector[k] !== v) return fail('E_RESULT', null, `lex-min vector mismatch at ${k}`);
  }
  return { ok: true, nodes };
}
