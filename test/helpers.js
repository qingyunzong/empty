import { Store } from '../src/store.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function tmpdir(prefix = 'trace-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function openStore(dir) {
  return Store.open(dir ?? tmpdir());
}

// Independent DFS reference implementation of the propagation semantics:
// recursive noisy-or over edge ratios with freeze containment, memoized.
// Deliberately shares no code with LineageGraph.computeProbs (which is an
// iterative Kahn topological sweep).
export function referenceProbs(snapshot, source) {
  const lots = new Map(snapshot.lots.map((l) => [l.id, l]));
  const inEdges = new Map();
  for (const e of snapshot.edges) {
    if (!inEdges.has(e.to)) inEdges.set(e.to, []);
    inEdges.get(e.to).push(e);
  }
  const memo = new Map();
  const solve = (v) => {
    if (v === source) return 1;
    if (memo.has(v)) return memo.get(v);
    memo.set(v, 0); // recursion guard (graph is a DAG)
    let prod = 1;
    for (const e of inEdges.get(v) ?? []) {
      const u = lots.get(e.from);
      if (u.frozen && e.from !== source) continue;
      prod *= 1 - solve(e.from) * e.ratio;
    }
    const p = 1 - prod;
    memo.set(v, p);
    return p;
  };
  const out = new Map();
  for (const id of lots.keys()) out.set(id, solve(id));
  return out;
}

export function referenceSet(snapshot, source, threshold) {
  const probs = referenceProbs(snapshot, source);
  return [...probs]
    .filter(([, p]) => p > 0 && p >= threshold)
    .map(([id]) => id)
    .sort();
}

// Builds a deterministic 20-lot random DAG exercising every edge kind:
//   raw x4 -> wip x7 -> finished x5 -> in_transit x2 -> customer_order x2
// plus: one 50/50 split (ratio conservation), one 2-input merge (qty
// conservation), one rework edge, frozen and failed lots.
export function buildRandomGraph(store, rng, n = 20) {
  const kinds = [
    ...Array(4).fill('raw'),
    ...Array(7).fill('wip'),
    ...Array(5).fill('finished'),
    ...Array(2).fill('in_transit'),
    ...Array(2).fill('customer_order'),
  ];
  const ids = kinds.map((_, i) => `L${i}`);
  const qtys = ids.map(() => 100 + Math.floor(rng() * 900));

  // Merge: L0 + L1 merge into L4 (wip); L4 qty must equal the sum.
  qtys[4] = qtys[0] + qtys[1];
  // Split: L5 (wip) splits 50/50 into L12 and L13 (finished).
  qtys[5] = 2 * (100 + Math.floor(rng() * 400));

  for (let i = 0; i < n; i++) {
    store.addLot({
      id: ids[i],
      kind: kinds[i],
      qty: qtys[i],
      time: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      frozen: i === 13, // one frozen finished lot: freeze containment
      failed: i === 0, // one failed raw lot
    });
  }

  let edgeSeq = 0;
  const edge = (from, to, kind, qty) =>
    store.addEdge({
      id: `E${edgeSeq++}`,
      from,
      to,
      kind,
      qty,
      time: `2026-02-${String(edgeSeq).padStart(2, '0')}T00:00:00Z`,
    });

  // Generic consume edges, always from a lower index to a higher one (DAG).
  for (let i = 1; i < n; i++) {
    if (i === 4 || i === 12 || i === 13) continue; // structured below
    const parent = Math.floor(rng() * i);
    edge(ids[parent], ids[i], 'consume', Math.max(1, Math.round(qtys[parent] * (0.2 + rng() * 0.5))));
  }
  // Extra random consume edges for density.
  for (let k = 0; k < 6; k++) {
    const from = Math.floor(rng() * (n - 1));
    const to = from + 1 + Math.floor(rng() * (n - from - 1));
    if (to === 4 || to === 12 || to === 13) continue;
    edge(ids[from], ids[to], 'consume', Math.max(1, Math.round(qtys[from] * 0.1)));
  }
  // Structured edges.
  edge(ids[0], ids[4], 'merge', qtys[0]);
  edge(ids[1], ids[4], 'merge', qtys[1]);
  edge(ids[5], ids[12], 'split', qtys[5] / 2);
  edge(ids[5], ids[13], 'split', qtys[5] / 2);
  edge(ids[11], ids[14], 'rework', Math.max(1, Math.round(qtys[11] * 0.1)));

  return { ids, kinds, qtys };
}
