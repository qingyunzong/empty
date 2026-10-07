import test from 'node:test';
import assert from 'node:assert/strict';
import { DynamicGraph, GraphError, ERRORS, comparePaths } from '../src/graph.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Brute-force reference: enumerate all simple paths, pick min by (cost, lex).
function bruteForce(edges, source, target) {
  const adj = new Map();
  for (const { from, to, cost, open } of edges) {
    if (!open) continue;
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push({ to, cost });
  }
  let best = null;
  const visit = (node, cost, path) => {
    if (node === target) {
      if (!best || cost < best.cost || (cost === best.cost && comparePaths(path, best.path) < 0)) {
        best = { cost, path: [...path] };
      }
      return;
    }
    for (const { to, cost: w } of adj.get(node) ?? []) {
      if (path.includes(to)) continue;
      visit(to, cost + w, [...path, to]);
    }
  };
  visit(source, 0, [source]);
  return best;
}

function snapshotEdges(graph) {
  return [...graph.edges.values()].map((e) => ({ ...e }));
}

test('1: incremental reweight keeps path and cost correct', () => {
  const g = new DynamicGraph();
  g.addEdge({ id: 'a', from: 'S', to: 'A', cost: 5 });
  g.addEdge({ id: 'b', from: 'A', to: 'T', cost: 5 });
  g.addEdge({ id: 'c', from: 'S', to: 'T', cost: 20 });

  let q = g.query('S', 'T');
  assert.deepEqual(q.path, ['S', 'A', 'T']);
  assert.equal(q.cost, 10);
  assert.equal(g.verify(q.cert), true);

  g.setCost('c', 8);
  q = g.query('S', 'T');
  assert.deepEqual(q.path, ['S', 'T']);
  assert.equal(q.cost, 8);
  assert.equal(g.verify(q.cert), true);

  g.setCost('a', 1);
  q = g.query('S', 'T');
  assert.deepEqual(q.path, ['S', 'A', 'T']);
  assert.equal(q.cost, 6);
  assert.equal(g.verify(q.cert), true);
});

test('2: close distinguishes detour from true disconnect', () => {
  const g = new DynamicGraph();
  g.addEdge({ id: 'a', from: 'S', to: 'A', cost: 1 });
  g.addEdge({ id: 'b', from: 'A', to: 'T', cost: 1 });
  g.addEdge({ id: 'c', from: 'S', to: 'T', cost: 5 });

  assert.deepEqual(g.query('S', 'T').path, ['S', 'A', 'T']);

  g.close('a'); // direct edge still available as a (cycle-free) detour
  const q = g.query('S', 'T');
  assert.deepEqual(q.path, ['S', 'T']);
  assert.equal(q.cost, 5);
  assert.equal(g.verify(q.cert), true);

  g.close('c'); // now T is truly unreachable from S
  assert.throws(() => g.query('S', 'T'), (err) => err instanceof GraphError && err.code === ERRORS.NO_PATH);

  g.open('a'); // reopen restores the cheap route
  assert.deepEqual(g.query('S', 'T').path, ['S', 'A', 'T']);
});

test('2b: lexicographic tie-break is stable among equal-cost paths', () => {
  const g = new DynamicGraph();
  g.addEdge({ id: '1', from: 'S', to: 'B', cost: 1 });
  g.addEdge({ id: '2', from: 'B', to: 'T', cost: 1 });
  g.addEdge({ id: '3', from: 'S', to: 'A', cost: 1 });
  g.addEdge({ id: '4', from: 'A', to: 'Z', cost: 1 });
  g.addEdge({ id: '5', from: 'Z', to: 'T', cost: 1 });
  // Two optimal cost-2... adjust: make both cost equal
  g.setCost('4', 0.5);
  g.setCost('5', 0.5);
  const q = g.query('S', 'T');
  assert.equal(q.cost, 2);
  assert.deepEqual(q.path, ['S', 'A', 'Z', 'T']); // 'A' < 'B' lexicographically
  assert.equal(g.verify(q.cert), true);
});

test('3: exhaustive brute-force cross-check on random graphs (n<=8)', () => {
  const rand = mulberry32(20261007);
  for (let trial = 0; trial < 60; trial += 1) {
    const n = 2 + Math.floor(rand() * 7); // 2..8 nodes
    const nodes = Array.from({ length: n }, (_, i) => `n${i}`);
    const g = new DynamicGraph();
    const m = Math.floor(rand() * n * (n - 1));
    for (let i = 0; i < m; i += 1) {
      const from = nodes[Math.floor(rand() * n)];
      const to = nodes[Math.floor(rand() * n)];
      if (from === to) continue;
      g.addEdge({ from, to, cost: 1 + Math.floor(rand() * 9) });
    }
    // Random incremental mutations: close/open/set_cost.
    const ids = [...g.edges.keys()];
    for (let k = 0; k < 6; k += 1) {
      if (ids.length === 0) break;
      const id = ids[Math.floor(rand() * ids.length)];
      const op = rand();
      if (op < 0.35) g.close(id);
      else if (op < 0.7) g.open(id);
      else g.setCost(id, 1 + Math.floor(rand() * 9));
    }
    const edges = snapshotEdges(g);
    for (const s of nodes) {
      for (const t of nodes) {
        const expected = bruteForce(edges, s, t);
        if (!expected) {
          assert.throws(
            () => g.query(s, t),
            (err) => err.code === ERRORS.NO_PATH,
            `expected NO_PATH ${s}->${t} trial ${trial}`,
          );
        } else {
          const q = g.query(s, t);
          assert.equal(q.cost, expected.cost, `cost ${s}->${t} trial ${trial}`);
          assert.deepEqual(q.path, expected.path, `path ${s}->${t} trial ${trial}`);
          assert.equal(g.verify(q.cert), true, `cert ${s}->${t} trial ${trial}`);
          assert.equal(q.cert.cost, expected.cost);
        }
      }
    }
  }
});

test('4: three consecutive undos restore state three mutations back', () => {
  const g = new DynamicGraph();
  g.addEdge({ id: 'a', from: 'S', to: 'T', cost: 10 }); // mutation 1
  const stateAfter1 = g.query('S', 'T');
  g.addEdge({ id: 'b', from: 'S', to: 'A', cost: 1 }); // mutation 2
  g.addEdge({ id: 'c', from: 'A', to: 'T', cost: 1 }); // mutation 3
  g.setCost('a', 100); // mutation 4

  assert.deepEqual(g.query('S', 'T').path, ['S', 'A', 'T']);

  g.undo(); // revert mutation 4
  assert.deepEqual(g.query('S', 'T').path, ['S', 'A', 'T']);
  assert.equal(g.query('S', 'T').cost, 2);

  g.undo(); // revert mutation 3
  assert.deepEqual(g.query('S', 'T').path, ['S', 'T']);
  assert.equal(g.query('S', 'T').cost, 10);

  g.undo(); // revert mutation 2 -> exactly the state after mutation 1
  const q = g.query('S', 'T');
  assert.deepEqual(q.path, stateAfter1.path);
  assert.equal(q.cost, stateAfter1.cost);

  g.undo(); // revert mutation 1 -> empty graph
  assert.throws(() => g.query('S', 'T'), (err) => err.code === ERRORS.NO_PATH);
  assert.throws(() => g.undo(), (err) => err.code === ERRORS.CONFLICT);
});

test('4b: undo restores closed/open state and cost snapshots', () => {
  const g = new DynamicGraph();
  g.addEdge({ id: 'a', from: 'S', to: 'T', cost: 4 });
  g.close('a');
  g.undo();
  assert.equal(g.query('S', 'T').cost, 4);
  g.setCost('a', 9);
  g.undo();
  assert.equal(g.query('S', 'T').cost, 4);
});

test('5: forged, stale or version-mismatched certificates fail verify', () => {
  const g = new DynamicGraph();
  g.addEdge({ id: 'a', from: 'S', to: 'A', cost: 2 });
  g.addEdge({ id: 'b', from: 'A', to: 'T', cost: 3 });
  g.addEdge({ id: 'c', from: 'S', to: 'T', cost: 10 });
  const q = g.query('S', 'T');
  assert.equal(g.verify(q.cert), true);

  const tampered = [
    { ...q.cert, cost: q.cert.cost - 1 }, // cheaper than optimal
    { ...q.cert, cost: q.cert.cost + 1 },
    { ...q.cert, path: ['S', 'T'] }, // path does not match potentials
    { ...q.cert, path: [...q.cert.path].reverse() },
    { ...q.cert, dist: { ...q.cert.dist, T: q.cert.dist.T - 1 } },
    { ...q.cert, dist: { ...q.cert.dist, A: q.cert.dist.A + 1 } }, // breaks tightness
    { ...q.cert, version: q.cert.version + 1 },
    { ...q.cert, version: -1 },
    { ...q.cert, from: 'A' },
    { ...q.cert, dist: { S: 0 } }, // missing potentials
    { ...q.cert, dist: { ...q.cert.dist, S: 1 } },
    null,
    {},
    'not-a-cert',
  ];
  for (const bad of tampered) {
    assert.throws(
      () => g.verify(bad),
      (err) => err instanceof GraphError && err.code === ERRORS.CERT_INVALID,
      `should reject: ${JSON.stringify(bad)}`,
    );
  }

  // Stale certificate: any later mutation bumps the graph version.
  g.setCost('c', 1);
  assert.throws(() => g.verify(q.cert), (err) => err.code === ERRORS.CERT_INVALID);
  // A fresh certificate for the new version verifies again.
  const fresh = g.query('S', 'T');
  assert.equal(fresh.cost, 1);
  assert.equal(g.verify(fresh.cert), true);
});

test('input validation and conflict error codes', () => {
  const g = new DynamicGraph();
  g.addEdge({ id: 'a', from: 'S', to: 'T', cost: 1 });
  assert.throws(() => g.addEdge({ id: 'a', from: 'S', to: 'T', cost: 1 }), (e) => e.code === ERRORS.CONFLICT);
  assert.throws(() => g.addEdge({ from: 'S', to: 'T', cost: -1 }), (e) => e.code === ERRORS.INVALID_INPUT);
  assert.throws(() => g.addEdge({ from: 'S', to: 'T', cost: Number.NaN }), (e) => e.code === ERRORS.INVALID_INPUT);
  assert.throws(() => g.addEdge({ from: '', to: 'T', cost: 1 }), (e) => e.code === ERRORS.INVALID_INPUT);
  assert.throws(() => g.close('missing'), (e) => e.code === ERRORS.INVALID_INPUT);
  assert.throws(() => g.setCost('a', 'x'), (e) => e.code === ERRORS.INVALID_INPUT);
});

test('query from a node to itself has cost 0', () => {
  const g = new DynamicGraph();
  g.addEdge({ id: 'a', from: 'S', to: 'T', cost: 1 });
  const q = g.query('S', 'S');
  assert.deepEqual(q.path, ['S']);
  assert.equal(q.cost, 0);
  assert.equal(g.verify(q.cert), true);
});
