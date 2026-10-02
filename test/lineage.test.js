'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { LineageGraph, LineageError } = require('../src/lineage');
const { Store } = require('../src/store');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-test-'));
}

// Reference: memoized DFS over predecessors evaluating the same propagation
// recurrence P(v) = 1 - prod(1 - P(u)*p_uv) via an independent code path.
function referenceProbs(graph, source) {
  const reachable = new Set([source]);
  const stack = [source];
  while (stack.length) {
    const cur = stack.pop();
    for (const eid of graph.outEdges.get(cur)) {
      const nxt = graph.edges.get(eid).to;
      if (!reachable.has(nxt)) {
        reachable.add(nxt);
        stack.push(nxt);
      }
    }
  }
  const memo = new Map();
  const solve = (v) => {
    if (v === source) return 1;
    if (memo.has(v)) return memo.get(v);
    memo.set(v, 0); // DAG guard
    let clean = 1;
    for (const eid of graph.inEdges.get(v)) {
      const e = graph.edges.get(eid);
      clean *= 1 - solve(e.from) * e.prob;
    }
    const p = 1 - clean;
    memo.set(v, p);
    return p;
  };
  const probs = new Map();
  for (const id of reachable) probs.set(id, solve(id));
  return probs;
}

function buildRandomGraph(seed, lotCount = 20) {
  const rnd = mulberry32(seed);
  const g = new LineageGraph();
  const statuses = ['in_stock', 'in_stock', 'in_transit', 'quarantine', 'delivered', 'consumed'];
  for (let i = 0; i < lotCount; i += 1) {
    const kind = i < 4 ? 'raw' : i < 14 ? 'wip' : 'finished';
    g.addLot({
      id: `L${i}`,
      kind,
      qty: 100 + Math.floor(rnd() * 900),
      status: statuses[Math.floor(rnd() * statuses.length)],
    });
  }
  const kinds = ['consume', 'split', 'merge', 'rework'];
  const outgoing = new Map();
  let edgeN = 0;
  for (let i = 0; i < lotCount; i += 1) {
    for (let j = i + 1; j < lotCount; j += 1) {
      if (rnd() < 0.16) {
        if (!outgoing.has(i)) outgoing.set(i, []);
        outgoing.get(i).push(j);
      }
    }
  }
  for (const [i, targets] of outgoing) {
    // split ratios: random weights normalized to sum <= 0.9 (conservation)
    const weights = targets.map(() => 0.05 + rnd());
    const wsum = weights.reduce((a, b) => a + b, 0);
    targets.forEach((j, k) => {
      const ratio = (weights[k] / wsum) * 0.9;
      g.addEdge({
        id: `e${edgeN++}`,
        from: `L${i}`,
        to: `L${j}`,
        kind: kinds[Math.floor(rnd() * kinds.length)],
        qty: Math.round(ratio * g.lots.get(`L${i}`).qty),
        ratio,
        time: edgeN,
      });
    });
  }
  return g;
}

test('acceptance 1: 20-lot random DAG matches DFS reference for every source', () => {
  for (const seed of [7, 42, 2026]) {
    const g = buildRandomGraph(seed, 20);
    for (let i = 0; i < 20; i += 1) {
      const src = `L${i}`;
      const expected = referenceProbs(g, src);
      const actual = g.downstreamProbs(src);
      assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort(),
        `seed=${seed} src=${src} reachable set mismatch`);
      for (const [id, p] of expected) {
        assert.ok(Math.abs(actual.get(id) - p) < 1e-9,
          `seed=${seed} src=${src} lot=${id}: ${actual.get(id)} != ${p}`);
      }
      // affected set via impact() must equal reference predicate
      for (const threshold of [0.05, 0.3, 0.6]) {
        const impact = g.impact(src, threshold);
        const refSet = [...expected.entries()]
          .filter(([id, p]) => id !== src && p + 1e-9 >= threshold
            && g.lots.get(id).status !== 'consumed')
          .map(([id]) => id)
          .sort();
        assert.deepEqual(impact.affected.map((a) => a.lot), refSet,
          `seed=${seed} src=${src} t=${threshold} affected mismatch`);
        assert.equal(impact.certificate.minimal, true);
        assert.equal(impact.certificate.complete, true);
      }
    }
  }
});

test('acceptance 2: cycle edge reports ERR_CYCLE and leaves state untouched', () => {
  const g = new LineageGraph();
  g.addLot({ id: 'A', kind: 'raw', qty: 100, status: 'quarantine' });
  g.addLot({ id: 'B', kind: 'wip', qty: 60, status: 'in_stock' });
  g.addLot({ id: 'C', kind: 'finished', qty: 30, status: 'in_stock' });
  g.addEdge({ id: 'ab', from: 'A', to: 'B', kind: 'split', qty: 60, ratio: 0.6, time: 1 });
  g.addEdge({ id: 'bc', from: 'B', to: 'C', kind: 'split', qty: 30, ratio: 0.5, time: 2 });
  const before = g.impact('A', 0.1);
  const edgeCount = g.edges.size;
  assert.throws(() => g.addEdge({ id: 'ca', from: 'C', to: 'A', kind: 'rework', qty: 5, ratio: 0.1, time: 3 }),
    (err) => err instanceof LineageError && err.code === 'ERR_CYCLE');
  assert.throws(() => g.addEdge({ id: 'aa', from: 'A', to: 'A', kind: 'rework', qty: 5, ratio: 0.1, time: 3 }),
    (err) => err.code === 'ERR_CYCLE');
  assert.equal(g.edges.size, edgeCount);
  assert.deepEqual(g.impact('A', 0.1), before);
  // conservation violation likewise rejected without pollution
  assert.throws(() => g.addEdge({ id: 'ab2', from: 'A', to: 'C', kind: 'split', qty: 50, ratio: 0.5, time: 3 }),
    (err) => err.code === 'ERR_CONSERVATION');
  assert.equal(g.edges.size, edgeCount);
  assert.deepEqual(g.impact('A', 0.1), before);
});

test('acceptance 3: correcting split ratio recomputes incrementally, matches full recompute, undo restores', () => {
  const dir = tmpDir();
  const store = Store.open(dir);
  store.addLot({ id: 'RAW', kind: 'raw', qty: 1000, status: 'quarantine' });
  store.addLot({ id: 'P1', kind: 'wip', qty: 500, status: 'in_stock' });
  store.addLot({ id: 'P2', kind: 'wip', qty: 300, status: 'in_stock' });
  store.addLot({ id: 'F1', kind: 'finished', qty: 700, status: 'in_transit' });
  store.addLot({ id: 'U1', kind: 'raw', qty: 100, status: 'in_stock' });
  store.addLot({ id: 'U2', kind: 'finished', qty: 90, status: 'in_stock' });
  store.addEdge({ id: 's1', from: 'RAW', to: 'P1', kind: 'split', qty: 500, ratio: 0.5, time: 1 });
  store.addEdge({ id: 's2', from: 'RAW', to: 'P2', kind: 'split', qty: 300, ratio: 0.3, time: 2 });
  store.addEdge({ id: 'm1', from: 'P1', to: 'F1', kind: 'merge', qty: 400, ratio: 0.8, time: 3 });
  store.addEdge({ id: 'm2', from: 'P2', to: 'F1', kind: 'merge', qty: 180, ratio: 0.6, time: 4 });
  store.addEdge({ id: 'u1', from: 'U1', to: 'U2', kind: 'split', qty: 90, ratio: 0.9, time: 5 });

  const t = 0.2;
  // warm the cache for several query roots, including unrelated subgraph
  for (const root of ['RAW', 'P1', 'P2', 'F1', 'U1']) store.impact(root, t);
  const before = store.impact('RAW', t);

  store.correctEdge('s1', { ratio: 0.7, qty: 700 }); // 0.7 + 0.3 = 1.0 conserved

  // incremental: only cached queries rooted at ancestors of RAW (i.e. RAW)
  // may be invalidated; P1/P2/F1/U1 entries survive.
  assert.equal(store.stats.invalidated, 1, 'only the RAW cache entry may be invalidated');
  const hitsBefore = store.stats.cacheHits;
  store.impact('P1', t);
  store.impact('U1', t);
  assert.equal(store.stats.cacheHits, hitsBefore + 2, 'unaffected subtrees served from cache');

  // incremental result must equal a from-scratch full recompute
  const incremental = store.impact('RAW', t);
  const fullRecompute = store.graph.impact('RAW', t);
  assert.deepEqual(incremental, fullRecompute);
  assert.notDeepEqual(incremental.affected, before.affected);

  // undo restores the original impact; redo reapplies the correction
  assert.equal(store.undo(), true);
  assert.deepEqual(store.impact('RAW', t).affected, before.affected);
  assert.equal(store.redo(), true);
  assert.deepEqual(store.impact('RAW', t).affected, fullRecompute.affected);

  // conservation still enforced on correction
  assert.throws(() => store.correctEdge('s1', { ratio: 0.71 }),
    (err) => err.code === 'ERR_CONSERVATION');
});
