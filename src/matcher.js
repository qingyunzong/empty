'use strict';

// Total order for match-conflict resolution: amount diff, time diff, internal id, external id.
function compareCandidateEdges(a, b) {
  if (a.amountDiff !== b.amountDiff) return a.amountDiff - b.amountDiff;
  if (a.timeDiff !== b.timeDiff) return a.timeDiff - b.timeDiff;
  if (a.i !== b.i) return a.i < b.i ? -1 : 1;
  if (a.e !== b.e) return a.e < b.e ? -1 : 1;
  return 0;
}

// Topology edge of the bipartite dependency graph (amount-agnostic; amounts are
// evaluated by the matcher). Two rows are dependent when they fall inside the
// active rule's time window.
function edgeExists(a, b, rule) {
  if (a.kind === b.kind) return false;
  return Math.abs(a.tsMs - b.tsMs) <= rule.timeWindowMs;
}

function candidatePairs(internals, externals, rule) {
  const edges = [];
  for (const i of internals) {
    for (const e of externals) {
      const amountDiff = Math.abs(i.amountCents - e.amountCents);
      const timeDiff = Math.abs(i.tsMs - e.tsMs);
      if (amountDiff <= rule.amountToleranceCents && timeDiff <= rule.timeWindowMs) {
        edges.push({ i: i.key, e: e.key, amountDiff, timeDiff });
      }
    }
  }
  edges.sort(compareCandidateEdges);
  return edges;
}

function* combinations(arr, size) {
  const n = arr.length;
  const idx = Array.from({ length: size }, (_, k) => k);
  for (;;) {
    yield idx.map((k) => arr[k]);
    let p = size - 1;
    while (p >= 0 && idx[p] === n - size + p) p--;
    if (p < 0) return;
    idx[p]++;
    for (let q = p + 1; q < size; q++) idx[q] = idx[q - 1] + 1;
  }
}

// Deterministic subset-sum: candidates sorted by key, subsets enumerated in
// lexicographic order of size then position; first subset within tolerance wins.
function findSubsetSum(cands, targetCents, tolCents, maxSize) {
  const arr = [...cands].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const limit = Math.min(maxSize, arr.length);
  for (let size = 2; size <= limit; size++) {
    for (const combo of combinations(arr, size)) {
      const sum = combo.reduce((s, r) => s + r.amountCents, 0);
      if (Math.abs(sum - targetCents) <= tolCents) return combo;
    }
  }
  return null;
}

const REJECT_DETECT_GROUP_SIZE = 3;
const byKeyCmp = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

// Match one connected component of the dependency graph. Per-component greedy
// by total order is equivalent to global greedy because components are disjoint.
function matchComponent(rows, rule) {
  const internals = rows.filter((r) => r.kind === 'internal');
  const externals = rows.filter((r) => r.kind === 'external');
  const edges = candidatePairs(internals, externals, rule);
  const state = new Map();
  const matchedI = new Set();
  const matchedE = new Set();
  const pairs = [];
  for (const edge of edges) {
    if (matchedI.has(edge.i) || matchedE.has(edge.e)) continue;
    matchedI.add(edge.i);
    matchedE.add(edge.e);
    pairs.push({
      internal: edge.i,
      external: edge.e,
      amountDiffCents: edge.amountDiff,
      timeDiffMs: edge.timeDiff,
    });
  }

  const groups = [];
  const rejectedGroups = [];
  const groupedI = new Set();
  const remE = externals.filter((r) => !matchedE.has(r.key)).sort(byKeyCmp);
  for (const e of remE) {
    const cand = internals.filter(
      (i) =>
        !matchedI.has(i.key) &&
        !groupedI.has(i.key) &&
        Math.abs(i.tsMs - e.tsMs) <= rule.timeWindowMs
    );
    const detect = rule.allowOneToMany
      ? rule.maxGroupSize
      : Math.max(rule.maxGroupSize, REJECT_DETECT_GROUP_SIZE);
    const subset = findSubsetSum(cand, e.amountCents, rule.amountToleranceCents, detect);
    if (!subset) continue;
    if (rule.allowOneToMany) {
      const sum = subset.reduce((s, r) => s + r.amountCents, 0);
      groups.push({
        external: e.key,
        members: subset.map((r) => r.key).sort(),
        amountDiffCents: Math.abs(sum - e.amountCents),
      });
      for (const m of subset) groupedI.add(m.key);
      matchedE.add(e.key);
    } else {
      rejectedGroups.push({ external: e.key, members: subset.map((r) => r.key).sort() });
    }
  }

  for (const p of pairs) {
    const st = p.amountDiffCents === 0 ? 'MATCHED' : 'MATCHED_ADJUST';
    state.set(p.internal, { status: st, partner: p.external });
    state.set(p.external, { status: st, partner: p.internal });
  }
  for (const g of groups) {
    const st = g.amountDiffCents === 0 ? 'MATCHED' : 'MATCHED_ADJUST';
    state.set(g.external, { status: st, group: g.members });
    for (const m of g.members) state.set(m, { status: st, group: g.external });
  }
  // Pending-manual items are UNRESOLVED with a reason, never unsatisfiable.
  for (const g of rejectedGroups) {
    for (const k of [g.external, ...g.members]) {
      if (!state.has(k)) state.set(k, { status: 'UNRESOLVED', reason: 'ONE_TO_MANY_REJECTED' });
    }
  }
  const hasEdge = new Set();
  for (const e of edges) {
    hasEdge.add(e.i);
    hasEdge.add(e.e);
  }
  for (const r of rows) {
    if (state.has(r.key)) continue;
    if (hasEdge.has(r.key)) {
      state.set(r.key, { status: 'UNRESOLVED', reason: 'MATCH_CONFLICT' });
    } else {
      state.set(r.key, {
        status: r.kind === 'internal' ? 'UNMATCHED_INTERNAL' : 'UNMATCHED_EXTERNAL',
      });
    }
  }
  return { pairs, groups, rejectedGroups, state };
}

module.exports = {
  compareCandidateEdges,
  edgeExists,
  candidatePairs,
  findSubsetSum,
  matchComponent,
};
