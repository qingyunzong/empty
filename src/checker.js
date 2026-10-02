// The checker: derives causal, real-time and commutativity constraints from
// the compiled rules, then searches for a serialization consistent with
// them and with per-key register semantics (a read observes the most recent
// write to its key, or null initially).
//
// Verdicts:
//   LINEARIZABLE     - a valid serialization exists (certificate: witness)
//   NON_LINEARIZABLE - constraints/semantics are contradictory
//                      (certificate: minimal counterexample subset)
//   UNKNOWN          - required events are missing (never used for
//                      contradictions or search failure)

import { evalPred } from './bytecode.js';
import { buildVersions } from './history.js';

const MAX_COUNTEREXAMPLE_CHECKS = 50000;

function viewOf(op) {
  return { op: op.op, key: op.key, value: op.value, node: op.node, time: op.tInv };
}

function deepEq(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

// Build ordering constraints. Returns { preds, reasons } where preds[j] is
// the set of indices that must precede j.
export function buildConstraints(ops, compiled) {
  const n = ops.length;
  const preds = Array.from({ length: n }, () => new Set());
  const reasons = new Map();
  const addEdge = (i, j, reason) => {
    if (i === j || preds[j].has(i)) return;
    preds[j].add(i);
    reasons.set(`${i}->${j}`, reason);
  };
  const views = ops.map(viewOf);
  const exempt = (i, j) => {
    for (const kind of ['concurrent', 'commutes']) {
      if (evalPred(compiled, kind, views[i], views[j])) return true;
      if (evalPred(compiled, kind, views[j], views[i])) return true;
    }
    return false;
  };
  const indexOf = new Map(ops.map((o, i) => [o.inv, i]));

  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if (i === j) continue;
      // Real-time order: response of i strictly before invocation of j.
      if (ops[i].tRes !== null && ops[j].tInv !== null && ops[i].tRes < ops[j].tInv) {
        if (!exempt(i, j)) addEdge(i, j, 'realtime');
      }
      // Rule-specified happens-before.
      if (evalPred(compiled, 'happens-before', views[i], views[j])) {
        addEdge(i, j, 'happens-before');
      }
    }
    // Causal order from prev links.
    for (const p of ops[i].prev) {
      const k = indexOf.get(p);
      if (k !== undefined) addEdge(k, i, 'causal');
    }
  }
  return { preds, reasons };
}

// Tarjan SCC; returns array of components (arrays of indices).
function stronglyConnected(preds) {
  const n = preds.length;
  const succ = Array.from({ length: n }, () => []);
  for (let j = 0; j < n; j += 1) for (const i of preds[j]) succ[i].push(j);
  const index = new Array(n).fill(-1);
  const low = new Array(n).fill(0);
  const onStack = new Array(n).fill(false);
  const stack = [];
  const sccs = [];
  let counter = 0;
  const strongconnect = (v) => {
    index[v] = counter; low[v] = counter; counter += 1;
    stack.push(v); onStack[v] = true;
    for (const w of succ[v]) {
      if (index[w] === -1) { strongconnect(w); low[v] = Math.min(low[v], low[w]); }
      else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
    }
    if (low[v] === index[v]) {
      const scc = [];
      let w;
      do { w = stack.pop(); onStack[w] = false; scc.push(w); } while (w !== v);
      sccs.push(scc);
    }
  };
  for (let v = 0; v < n; v += 1) if (index[v] === -1) strongconnect(v);
  return sccs;
}

function findCycleComponents(ops, preds) {
  const cyclic = stronglyConnected(preds).filter(
    (scc) => scc.length > 1 || preds[scc[0]].has(scc[0]),
  );
  return cyclic;
}

// Backtracking search for a valid serialization, memoized on
// (placed set, per-key last-written values). Deterministic: candidates are
// tried in ascending invocation-id order.
export function findSerialization(ops, preds) {
  const n = ops.length;
  const full = (1n << BigInt(n)) - 1n;
  const lastVal = new Map();
  const memo = new Set();
  const order = [];
  const sortedIdx = ops.map((_, i) => i).sort((a, b) => (ops[a].inv < ops[b].inv ? -1 : 1));

  const signature = (mask) =>
    `${mask.toString(36)}|${JSON.stringify([...lastVal.entries()].sort())}`;

  const dfs = (mask) => {
    if (mask === full) return true;
    const sig = signature(mask);
    if (memo.has(sig)) return false;
    for (const c of sortedIdx) {
      const bit = 1n << BigInt(c);
      if (mask & bit) continue;
      let ready = true;
      for (const p of preds[c]) {
        if (!(mask & (1n << BigInt(p)))) { ready = false; break; }
      }
      if (!ready) continue;
      const o = ops[c];
      if (o.op === 'read') {
        const cur = lastVal.has(o.key) ? lastVal.get(o.key) : null;
        if (!deepEq(cur, o.value)) continue;
        order.push(c);
        if (dfs(mask | bit)) return true;
        order.pop();
      } else if (o.op === 'write') {
        const had = lastVal.has(o.key);
        const old = lastVal.get(o.key);
        lastVal.set(o.key, o.value);
        order.push(c);
        if (dfs(mask | bit)) return true;
        order.pop();
        if (had) lastVal.set(o.key, old); else lastVal.delete(o.key);
      } else {
        order.push(c);
        if (dfs(mask | bit)) return true;
        order.pop();
      }
    }
    memo.add(sig);
    return false;
  };

  return dfs(0n) ? order.map((i) => ops[i].inv) : null;
}

function* combinations(sortedIds, size) {
  const idx = [];
  const n = sortedIds.length;
  const rec = function* (start, left) {
    if (left === 0) { yield idx.slice(); return; }
    for (let i = start; i <= n - left; i += 1) {
      idx.push(i);
      yield* rec(i + 1, left - 1);
      idx.pop();
    }
  };
  yield* rec(0, size);
}

function checkSingle(ops, compiled, { induced = false, wantCounterexample = true } = {}) {
  // 1. Missing required events => UNKNOWN (only possible verdict source).
  const ids = new Set(ops.map((o) => o.inv));
  const missing = [];
  for (const o of ops) {
    if (o.res === null || o.tRes === null) {
      missing.push({ event: o.inv, reason: 'missing response event' });
    }
    for (const p of o.prev) {
      if (!ids.has(p)) {
        if (induced) continue; // induced sub-histories drop external prev links
        missing.push({ event: o.inv, reason: `missing causal predecessor ${JSON.stringify(p)}` });
      }
    }
  }
  if (missing.length > 0) {
    return { verdict: 'UNKNOWN', certificate: { kind: 'missing', missing } };
  }

  const effectiveOps = induced
    ? ops.map((o) => ({ ...o, prev: o.prev.filter((p) => ids.has(p)) }))
    : ops;

  // 2. Constraint cycle => NON_LINEARIZABLE.
  const { preds } = buildConstraints(effectiveOps, compiled);
  const cyclic = findCycleComponents(effectiveOps, preds);
  if (cyclic.length > 0) {
    const byIds = (scc) => scc.map((i) => effectiveOps[i].inv).sort();
    cyclic.sort((a, b) => {
      if (a.length !== b.length) return a.length - b.length;
      const sa = byIds(a); const sb = byIds(b);
      return JSON.stringify(sa) < JSON.stringify(sb) ? -1 : 1;
    });
    return {
      verdict: 'NON_LINEARIZABLE',
      certificate: { kind: 'cycle', operations: byIds(cyclic[0]) },
    };
  }

  // 3. Search for a serialization.
  const witness = findSerialization(effectiveOps, preds);
  if (witness) {
    return { verdict: 'LINEARIZABLE', certificate: { kind: 'serialization', order: witness } };
  }

  // 4. Contradiction: find the shortest counterexample; ties broken by
  //    ascending event-id order.
  let operations = effectiveOps.map((o) => o.inv).sort();
  if (wantCounterexample) {
    const found = minimalCounterexample(effectiveOps, compiled);
    if (found) operations = found;
  }
  return {
    verdict: 'NON_LINEARIZABLE',
    certificate: { kind: 'counterexample', operations },
  };
}

function minimalCounterexample(ops, compiled) {
  const n = ops.length;
  const sortedIdx = ops.map((_, i) => i).sort((a, b) => (ops[a].inv < ops[b].inv ? -1 : 1));
  let checks = 0;
  for (let size = 1; size < n; size += 1) {
    for (const comb of combinations(sortedIdx, size)) {
      checks += 1;
      if (checks > MAX_COUNTEREXAMPLE_CHECKS) return null;
      const sub = comb.map((pos) => ops[sortedIdx[pos]]);
      const r = checkSingle(sub, compiled, { induced: true, wantCounterexample: false });
      if (r.verdict === 'NON_LINEARIZABLE') {
        return sub.map((o) => o.inv).sort();
      }
    }
  }
  return null;
}

// Check a single history version (array of normalized operations).
export function checkVersion(ops, compiled) {
  return checkSingle(ops, compiled, { induced: false, wantCounterexample: true });
}

// Check all versions induced by corrections. All but the final version are
// marked SUPERSEDED; the final one is CURRENT.
export function runCheck(events, compiled, file = '<history>') {
  const versions = buildVersions(events, file);
  const results = versions.map((ops, i) => ({
    version: i + 1,
    ...checkVersion(ops, compiled),
    status: i === versions.length - 1 ? 'CURRENT' : 'SUPERSEDED',
  }));
  return { verdict: results[results.length - 1].verdict, versions: results };
}
