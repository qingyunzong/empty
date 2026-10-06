import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DirectedGraph, type EdgeOp } from '../src/graph';
import { ReferenceGraph } from '../src/reference';

test('add/remove edges and reachability', () => {
  const g = new DirectedGraph();
  g.addEdge('a', 'b');
  g.addEdge('b', 'c');
  assert.equal(g.reachable('a', 'c'), true);
  assert.equal(g.reachable('c', 'a'), false);
  assert.deepEqual(g.shortestPath('a', 'c'), ['a', 'b', 'c']);

  g.removeEdge('b', 'c');
  assert.equal(g.reachable('a', 'c'), false);
  assert.equal(g.shortestPath('a', 'c'), null);
  assert.equal(g.reachable('a', 'b'), true);
});

test('shortest path prefers fewest hops, ties broken by smallest node sequence', () => {
  const g = new DirectedGraph();
  // Two 3-hop paths s->b->c->t and s->a->c->t: the latter is lexicographically smaller.
  g.applyBatch([
    { type: 'add', from: 's', to: 'b' },
    { type: 'add', from: 's', to: 'a' },
    { type: 'add', from: 'a', to: 'c' },
    { type: 'add', from: 'b', to: 'c' },
    { type: 'add', from: 'c', to: 't' },
  ]);
  assert.deepEqual(g.shortestPath('s', 't'), ['s', 'a', 'c', 't']);

  // A lexicographically larger but shorter path must win on length first.
  g.addEdge('s', 'z');
  g.addEdge('z', 't');
  assert.deepEqual(g.shortestPath('s', 't'), ['s', 'z', 't']);
});

test('self-loops are allowed and harmless', () => {
  const g = new DirectedGraph();
  g.addEdge('a', 'a');
  assert.equal(g.hasEdge('a', 'a'), true);
  assert.equal(g.reachable('a', 'a'), true);
  assert.deepEqual(g.shortestPath('a', 'a'), ['a']);

  g.addEdge('a', 'b');
  assert.deepEqual(g.shortestPath('a', 'b'), ['a', 'b']);

  // A node reaches itself even without a self-loop.
  const h = new DirectedGraph();
  h.addEdge('x', 'y');
  assert.equal(h.reachable('x', 'x'), true);
  assert.deepEqual(h.shortestPath('x', 'x'), ['x']);

  g.removeEdge('a', 'a');
  assert.equal(g.hasEdge('a', 'a'), false);
});

test('batch modifications are atomic: one invalid op rejects the whole batch', () => {
  const g = new DirectedGraph();
  g.addEdge('a', 'b');
  const before = g.edges();

  assert.throws(
    () =>
      g.applyBatch([
        { type: 'add', from: 'b', to: 'c' },
        { type: 'remove', from: 'a', to: 'b' },
        { type: 'bogus', from: 'c', to: 'd' } as unknown as EdgeOp,
      ]),
    TypeError,
  );
  assert.deepEqual(g.edges(), before);
  assert.equal(g.reachable('a', 'b'), true);
  assert.equal(g.reachable('b', 'c'), false);

  // A valid batch applies entirely.
  const res = g.applyBatch([
    { type: 'add', from: 'b', to: 'c' },
    { type: 'remove', from: 'a', to: 'b' },
  ]);
  assert.equal(g.reachable('a', 'b'), false);
  assert.equal(g.reachable('b', 'c'), true);
  assert.deepEqual(res.affectedSources, ['a', 'b']);
});

test('no-op batches affect nothing and keep the cache warm', () => {
  const g = new DirectedGraph();
  g.addEdge('a', 'b');
  g.reachable('a', 'b'); // warm cache for source 'a'
  const res = g.applyBatch([
    { type: 'add', from: 'a', to: 'b' }, // already present
    { type: 'remove', from: 'b', to: 'a' }, // absent
    { type: 'add', from: 'a', to: 'b' },
    { type: 'remove', from: 'a', to: 'b' },
    { type: 'add', from: 'a', to: 'b' }, // net: unchanged
  ]);
  assert.deepEqual(res.affectedSources, []);
  assert.equal(g.cachedSourceCount, 1);
});

test('affected source set covers exactly the sources upstream of flipped edges', () => {
  const g = new DirectedGraph();
  g.applyBatch([
    { type: 'add', from: 'a', to: 'b' },
    { type: 'add', from: 'b', to: 'c' },
    { type: 'add', from: 'x', to: 'y' },
  ]);
  // Warm caches so invalidation is observable.
  for (const s of ['a', 'b', 'c', 'x', 'y']) g.reachable(s, 'c');
  assert.equal(g.cachedSourceCount, 5);

  const res = g.removeEdge('b', 'c');
  assert.deepEqual(res.affectedSources, ['a', 'b']);
  assert.equal(g.cachedSourceCount, 3); // 'a' and 'b' invalidated

  // Post-removal answers must reflect the new graph (cache actually dropped).
  assert.equal(g.reachable('a', 'c'), false);
  assert.equal(g.reachable('b', 'c'), false);
  assert.equal(g.reachable('x', 'y'), true);
});

test('cache invalidation after edge removal matches per-source BFS reference', () => {
  const g = new DirectedGraph();
  g.applyBatch([
    { type: 'add', from: 'a', to: 'b' },
    { type: 'add', from: 'b', to: 'c' },
    { type: 'add', from: 'a', to: 'c' },
    { type: 'add', from: 'c', to: 'd' },
  ]);
  // Warm the cache, then verify stale results cannot survive a removal.
  assert.deepEqual(g.shortestPath('a', 'd'), ['a', 'c', 'd']);
  const res = g.removeEdge('a', 'c');
  assert.ok(res.affectedSources.includes('a'));

  const ref = new ReferenceGraph([
    ['a', 'b'],
    ['b', 'c'],
    ['c', 'd'],
  ]);
  assert.deepEqual(g.shortestPath('a', 'd'), ref.shortestPath('a', 'd'));
  assert.deepEqual(g.shortestPath('a', 'd'), ['a', 'b', 'c', 'd']);
  for (const s of ['a', 'b', 'c', 'd']) {
    for (const t of ['a', 'b', 'c', 'd']) {
      assert.equal(g.reachable(s, t), ref.reachable(s, t), `${s} -> ${t}`);
    }
  }
});

test('randomized differential test against per-source BFS reference', () => {
  // Deterministic PRNG (mulberry32).
  let state = 0x9e3779b9;
  const rand = () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;

  const nodes = Array.from({ length: 10 }, (_, i) => `n${i}`);
  const g = new DirectedGraph();
  const ref = new ReferenceGraph();

  const checkAllPairs = (ctx: string) => {
    for (const s of nodes) {
      for (const t of nodes) {
        assert.equal(g.reachable(s, t), ref.reachable(s, t), `${ctx}: reachable ${s}->${t}`);
        assert.deepEqual(g.shortestPath(s, t), ref.shortestPath(s, t), `${ctx}: path ${s}->${t}`);
      }
    }
  };

  for (let round = 0; round < 150; round++) {
    const before = new Map(nodes.map((s) => [s, ref.reachableSet(s)]));

    const ops: EdgeOp[] = [];
    const opCount = 1 + Math.floor(rand() * 5);
    for (let i = 0; i < opCount; i++) {
      const from = pick(nodes);
      const to = pick(nodes); // may be a self-loop
      ops.push({ type: rand() < 0.6 ? 'add' : 'remove', from, to });
    }
    const { affectedSources } = g.applyBatch(ops);
    for (const op of ops) {
      if (op.type === 'add') ref.add(op.from, op.to);
      else ref.remove(op.from, op.to);
    }

    // Every source whose reachable set changed must be reported as affected.
    const affected = new Set(affectedSources);
    for (const s of nodes) {
      const after = ref.reachableSet(s);
      const prev = before.get(s)!;
      const changed = prev.size !== after.size || [...prev].some((n) => !after.has(n));
      if (changed) {
        assert.ok(affected.has(s), `round ${round}: changed source ${s} missing from affected set`);
      }
    }
    // Affected list must be sorted.
    assert.deepEqual(affectedSources, [...affectedSources].sort());

    checkAllPairs(`round ${round}`);
  }
});
