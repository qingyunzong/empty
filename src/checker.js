// The linearizability checker. For each history version it builds a
// constraint graph from causal (prev), real-time (invocation/response) and
// rule-derived happens-before edges, removes real-time edges for pairs
// declared concurrent, then searches topological orders of the graph for a
// serialization that is register-valid up to commutation.

import { run } from './vm.js';
import { jsonEq, pairKey, validUpToCommutation } from './semantics.js';

const LEAF_CAP = 2000000;

function matchPattern(pat, ev, slots) {
  if (pat.op !== ev.op) return false;
  for (const arg of pat.args) {
    if (arg.t === 'wild') continue;
    const v = ev[arg.field];
    if (arg.t === 'lit') {
      if (!jsonEq(arg.v, v)) return false;
    } else if (arg.t === 'regex') {
      if (typeof v !== 'string' || !arg.re.test(v)) return false;
    } else if (arg.t === 'var') {
      if (slots[arg.slot] === undefined) slots[arg.slot] = v;
      else if (!jsonEq(slots[arg.slot], v)) return false;
    }
  }
  return true;
}

function matchConstraint(rule, ea, eb, ctx) {
  const slots = new Array(rule.numSlots);
  slots[0] = ea;
  slots[1] = eb;
  if (!matchPattern(rule.patA, ea, slots)) return false;
  if (!matchPattern(rule.patB, eb, slots)) return false;
  if (!rule.when) return true;
  return Boolean(run(rule.when, { ...ctx, slots }));
}

function transitiveClosure(n, edgeSet) {
  const adj = Array.from({ length: n }, () => []);
  for (const key of edgeSet) {
    const [u, v] = key.split(',').map(Number);
    adj[u].push(v);
  }
  const reach = Array.from({ length: n }, () => new Set());
  for (let s = 0; s < n; s++) {
    const stack = [s];
    while (stack.length) {
      const u = stack.pop();
      for (const v of adj[u]) {
        if (!reach[s].has(v)) {
          reach[s].add(v);
          stack.push(v);
        }
      }
    }
  }
  return reach;
}

// Build the constraint graph and commutation relation for one version.
export function buildConstraints(events, compiled) {
  const n = events.length;
  const byId = new Map(events.map((e, i) => [e.id, i]));
  const prevEdges = new Set();
  const rtEdges = new Set();

  events.forEach((e, j) => {
    if (e.prev != null) {
      const p = byId.get(e.prev);
      if (p !== undefined && p !== j) prevEdges.add(`${p},${j}`);
    }
  });
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (events[i].response <= events[j].invocation) rtEdges.add(`${i},${j}`);
      if (events[j].response <= events[i].invocation) rtEdges.add(`${j},${i}`);
    }
  }

  // Base graph (causal + real-time) backs the happens-before / concurrent
  // builtins available to when-expressions.
  const baseEdges = new Set([...prevEdges, ...rtEdges]);
  const reach = transitiveClosure(n, baseEdges);
  const idxOf = new Map(events.map((e, i) => [e, i]));
  const hbFn = (a, b) => reach[idxOf.get(a)].has(idxOf.get(b));
  const concFn = (a, b) => {
    const i = idxOf.get(a);
    const j = idxOf.get(b);
    return i !== j && !reach[i].has(j) && !reach[j].has(i);
  };

  const byKind = { commutes: [], 'happens-before': [], concurrent: [] };
  for (const c of compiled.constraints) byKind[c.kind].push(c);

  // Commutation pairs first: hb/concurrent when-expressions may query them.
  const commutePairs = [];
  const commIdx = new Set();
  const commFn = (a, b) => {
    const i = idxOf.get(a);
    const j = idxOf.get(b);
    return commIdx.has(i < j ? `${i},${j}` : `${j},${i}`);
  };
  const baseCtx = { hb: hbFn, conc: concFn, comm: commFn };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const hit = byKind.commutes.some((r) =>
        matchConstraint(r, events[i], events[j], baseCtx) ||
        matchConstraint(r, events[j], events[i], baseCtx));
      if (hit) {
        commutePairs.push([i, j]);
        commIdx.add(`${i},${j}`);
      }
    }
  }

  // Concurrent rules cancel real-time edges between matched pairs.
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const hit = byKind.concurrent.some((r) =>
        matchConstraint(r, events[i], events[j], baseCtx) ||
        matchConstraint(r, events[j], events[i], baseCtx));
      if (hit) {
        rtEdges.delete(`${i},${j}`);
        rtEdges.delete(`${j},${i}`);
      }
    }
  }

  const hbEdges = new Set();
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const hit = byKind['happens-before'].some((r) =>
        matchConstraint(r, events[i], events[j], baseCtx));
      if (hit) hbEdges.add(`${i},${j}`);
    }
  }

  const edges = [...prevEdges, ...rtEdges, ...hbEdges].map((k) => k.split(',').map(Number));
  return { edges, commutePairs };
}

// Depth-first enumeration of topological orders; returns the first order
// that is register-valid up to commutation, or null.
export function findSerialization(events, edges, commKeySet, effects, leafCap = LEAF_CAP) {
  const n = events.length;
  const adj = Array.from({ length: n }, () => []);
  const indeg = new Array(n).fill(0);
  for (const [u, v] of edges) {
    adj[u].push(v);
    indeg[v]++;
  }
  const order = [];
  const used = new Array(n).fill(false);
  let leaves = 0;
  let capped = false;

  function dfs() {
    if (capped) return null;
    if (order.length === n) {
      leaves++;
      if (leaves > leafCap) {
        capped = true;
        return null;
      }
      const seq = order.map((i) => events[i]);
      return validUpToCommutation(seq, commKeySet, effects) ? order.slice() : null;
    }
    for (let i = 0; i < n; i++) {
      if (used[i] || indeg[i] > 0) continue;
      used[i] = true;
      order.push(i);
      for (const v of adj[i]) indeg[v]--;
      const r = dfs();
      if (r) return r;
      for (const v of adj[i]) indeg[v]++;
      order.pop();
      used[i] = false;
    }
    return null;
  }

  const found = dfs();
  return { order: found, capped, leaves };
}

function* combinations(n, k) {
  if (k > n) return;
  const idx = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    yield idx;
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

function inducedSub(events, edges, commutePairs, indices) {
  const inSub = new Set(indices);
  const remap = new Map(indices.map((old, i) => [old, i]));
  const subEvents = indices.map((i) => events[i]);
  const subEdges = edges.filter(([u, v]) => inSub.has(u) && inSub.has(v))
    .map(([u, v]) => [remap.get(u), remap.get(v)]);
  const subCommutes = commutePairs.filter(([u, v]) => inSub.has(u) && inSub.has(v))
    .map(([u, v]) => [remap.get(u), remap.get(v)]);
  return { subEvents, subEdges, subCommutes };
}

function isNonLinearizable(events, edges, commutePairs, effects) {
  const commKeySet = new Set(commutePairs.map(([u, v]) => pairKey(events[u].id, events[v].id)));
  return findSerialization(events, edges, commKeySet, effects).order === null;
}

// Find the canonical shortest counterexample: smallest non-linearizable
// subset, ties broken by lexicographic order of the sorted event ids.
export function minimalCounterexample(events, edges, commutePairs, effects) {
  const n = events.length;
  if (n <= 12) {
    for (let k = 1; k <= n; k++) {
      for (const combo of combinations(n, k)) {
        const { subEvents, subEdges, subCommutes } = inducedSub(events, edges, commutePairs, combo);
        if (isNonLinearizable(subEvents, subEdges, subCommutes, effects)) {
          return { counterexample: combo.map((i) => events[i].id), minimal: true };
        }
      }
    }
    return { counterexample: events.map((e) => e.id), minimal: true };
  }
  // Large histories: greedy minimization (1-minimal, not size-minimal).
  let current = events.map((_, i) => i);
  let changed = true;
  while (changed) {
    changed = false;
    for (const i of current) {
      const trial = current.filter((x) => x !== i);
      const { subEvents, subEdges, subCommutes } = inducedSub(events, edges, commutePairs, trial);
      if (isNonLinearizable(subEvents, subEdges, subCommutes, effects)) {
        current = trial;
        changed = true;
        break;
      }
    }
  }
  return { counterexample: current.map((i) => events[i].id).sort(), minimal: false };
}

// Check one history version. Events are sorted by id for determinism.
export function checkVersion(events, compiled) {
  const sorted = events.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ids = new Set(sorted.map((e) => e.id));
  const pending = sorted.filter((e) => e.response == null).map((e) => e.id);
  const danglingPrev = sorted.filter((e) => e.prev != null && !ids.has(e.prev)).map((e) => e.id);
  if (pending.length > 0 || danglingPrev.length > 0) {
    return { verdict: 'UNKNOWN', pending, danglingPrev, events: sorted, edges: [], commutePairs: [] };
  }

  const { edges, commutePairs } = buildConstraints(sorted, compiled);
  const commKeySet = new Set(commutePairs.map(([u, v]) => pairKey(sorted[u].id, sorted[v].id)));
  const res = findSerialization(sorted, edges, commKeySet, compiled.effects);

  if (res.order) {
    return {
      verdict: 'LINEARIZABLE',
      serialization: res.order.map((i) => sorted[i].id),
      events: sorted,
      edges,
      commutePairs,
    };
  }
  const ce = minimalCounterexample(sorted, edges, commutePairs, compiled.effects);
  return {
    verdict: 'NON_LINEARIZABLE',
    ...ce,
    searchComplete: !res.capped,
    events: sorted,
    edges,
    commutePairs,
  };
}
