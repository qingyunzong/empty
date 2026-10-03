'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FreezeEngine, FreezeError } = require('../src/engine');
const { buildAdjacency, reverseAdjacency, reachable, findCycle } = require('../src/graph');

// Acceptance scenario 1: a merged batch sits under both an upstream
// (customer) and a downstream (supplier) freeze; its reason set must be the
// union of every triggering hold.
test('merged batch collects the union of upstream and downstream freeze reasons', () => {
  const engine = new FreezeEngine();
  // Merge: M derives from A and B (M -> A, M -> B). C derives from M (C -> M).
  engine.loadGraph({ edges: [['M', 'A'], ['M', 'B'], ['C', 'M']] });
  engine.addHold({ id: 'sup-a', lot: 'A', type: 'supplier', severity: 3 });
  engine.addHold({ id: 'cust-c', lot: 'C', type: 'customer', severity: 5 });

  const merged = engine.query('M');
  assert.equal(merged.frozen, true);
  assert.deepEqual(merged.reasons, ['cust-c', 'sup-a']);
  assert.equal(merged.severity, 5);

  // C sits under both: its own customer hold and the supplier hold from A.
  assert.deepEqual(engine.query('C').reasons, ['cust-c', 'sup-a']);
  // Customer freeze travels upstream to all source batches.
  assert.deepEqual(engine.query('A').reasons, ['cust-c', 'sup-a']);
  assert.deepEqual(engine.query('B').reasons, ['cust-c']);
});

// Acceptance scenario 2: two holds with different severities overlap; after
// releasing one, the other still applies and no stale reason remains.
test('releasing one of two holds keeps the other effective and drops its reason', () => {
  const engine = new FreezeEngine();
  engine.loadGraph({ edges: [['D', 'S']] });
  engine.addHold({ id: 'h-low', lot: 'S', type: 'supplier', severity: 2 });
  engine.addHold({ id: 'h-high', lot: 'D', type: 'customer', severity: 7 });

  let status = engine.query('S');
  assert.deepEqual(status.reasons, ['h-high', 'h-low']);
  assert.equal(status.severity, 7);

  engine.releaseHold('h-high');
  status = engine.query('S');
  assert.equal(status.frozen, true);
  assert.deepEqual(status.reasons, ['h-low']);
  assert.equal(status.severity, 2);
  // D is downstream of S, so the remaining supplier hold still reaches it.
  assert.deepEqual(engine.query('D').reasons, ['h-low']);

  // Undo restores the released hold and its reasons.
  engine.undo();
  status = engine.query('S');
  assert.deepEqual(status.reasons, ['h-high', 'h-low']);
  assert.equal(status.severity, 7);
});

// Acceptance scenario 3: a cyclic graph is rejected before any transaction
// is processed and leaves no partial results.
test('cyclic graph is rejected atomically with no partial state', () => {
  const engine = new FreezeEngine();
  assert.throws(
    () => engine.loadGraph({ edges: [['A', 'B'], ['B', 'C'], ['C', 'A']] }),
    (err) => err instanceof FreezeError && /cycle/.test(err.message),
  );
  assert.deepEqual(engine.edges, []);
  assert.deepEqual(engine.query(), []);

  // A previously valid state must survive a failed cyclic reload.
  engine.loadGraph({ edges: [['X', 'Y']] });
  engine.addHold({ id: 'keep', lot: 'Y', type: 'supplier', severity: 1 });
  assert.throws(() => engine.loadGraph({ edges: [['P', 'Q'], ['Q', 'P']] }), FreezeError);
  assert.deepEqual(engine.edges, [['X', 'Y']]);
  assert.deepEqual(engine.query('X').reasons, ['keep']);
});

test('null severity means unknown but still frozen, and null dominates max', () => {
  const engine = new FreezeEngine();
  engine.loadGraph({ edges: [['D', 'S']] });
  engine.addHold({ id: 'h-num', lot: 'S', type: 'supplier', severity: 9 });
  engine.addHold({ id: 'h-null', lot: 'S', type: 'supplier', severity: null });

  const status = engine.query('S');
  assert.equal(status.frozen, true);
  assert.equal(status.severity, null);
  assert.deepEqual(status.reasons, ['h-null', 'h-num']);

  engine.releaseHold('h-null');
  assert.equal(engine.query('S').severity, 9);
});

test('split/merge edges are incremental transactions and undoable', () => {
  const engine = new FreezeEngine();
  engine.loadGraph({ edges: [['M', 'A']] });
  engine.addHold({ id: 'sup-a', lot: 'A', type: 'supplier', severity: 4 });
  assert.equal(engine.query('B').frozen, false);

  // Merge transaction: M now also derives from B.
  engine.addEdges([['M', 'B']]);
  assert.deepEqual(engine.query('B').reasons, []);

  // Split transactions: M splits into S1 and S2 downstream.
  engine.addEdges([['S1', 'M']]);
  engine.addEdges([['S2', 'M']]);
  assert.deepEqual(engine.query('S1').reasons, ['sup-a']);
  assert.deepEqual(engine.query('S2').reasons, ['sup-a']);

  // A cyclic incremental transaction is rejected without partial edges.
  assert.throws(() => engine.addEdges([['A', 'S1']]), FreezeError);
  assert.equal(engine.query('A').frozen, true);

  engine.undo();
  assert.equal(engine.query('S2').frozen, false);
  assert.deepEqual(engine.query('S1').reasons, ['sup-a']);
});

test('releasing a hold recomputes the closure with no residual reasons', () => {
  const engine = new FreezeEngine();
  engine.loadGraph({ edges: [['D1', 'S'], ['D2', 'D1']] });
  engine.addHold({ id: 'h1', lot: 'S', type: 'supplier', severity: 1 });
  engine.addHold({ id: 'h2', lot: 'D2', type: 'customer', severity: 2 });

  engine.releaseHold('h1');
  engine.releaseHold('h2');
  for (const lot of ['S', 'D1', 'D2']) {
    const status = engine.query(lot);
    assert.equal(status.frozen, false);
    assert.deepEqual(status.reasons, []);
    assert.equal(status.severity, null);
  }

  engine.undo();
  assert.deepEqual(engine.query('S').reasons, ['h2']);
  engine.undo();
  assert.deepEqual(engine.query('D2').reasons, ['h1', 'h2']);
});

test('reference algorithm enumerates all reachable nodes independently', () => {
  const edges = [['M', 'A'], ['M', 'B'], ['C', 'M'], ['L', 'C']];
  const adj = buildAdjacency(edges);
  const rev = reverseAdjacency(adj);

  // Upstream reachability (child -> parent direction).
  assert.deepEqual([...reachable(adj, 'L')].sort(), ['A', 'B', 'C', 'L', 'M']);
  assert.deepEqual([...reachable(adj, 'M')].sort(), ['A', 'B', 'M']);
  // Downstream reachability (reverse direction).
  assert.deepEqual([...reachable(rev, 'A')].sort(), ['A', 'C', 'L', 'M']);
  assert.deepEqual([...reachable(rev, 'C')].sort(), ['C', 'L']);

  assert.equal(findCycle(adj), null);
  assert.deepEqual(findCycle(buildAdjacency([['A', 'B'], ['B', 'A']])), ['A', 'B', 'A']);
});

test('state round-trips through JSON for CLI persistence', () => {
  const engine = new FreezeEngine();
  engine.loadGraph({ edges: [['D', 'S']] });
  engine.addHold({ id: 'h', lot: 'S', type: 'supplier', severity: null });
  engine.releaseHold('h');

  const restored = FreezeEngine.fromJSON(JSON.parse(JSON.stringify(engine)));
  assert.equal(restored.query('S').frozen, false);
  restored.undo();
  assert.deepEqual(restored.query('D').reasons, ['h']);
  assert.equal(restored.query('D').severity, null);
});

test('invalid holds and unknown releases are rejected', () => {
  const engine = new FreezeEngine();
  engine.loadGraph({ edges: [['D', 'S']] });
  assert.throws(() => engine.addHold({ id: 'x', lot: 'S', type: 'weird' }), FreezeError);
  assert.throws(() => engine.addHold({ id: 'x', lot: 'S', type: 'supplier', severity: 'high' }), FreezeError);
  assert.throws(() => engine.releaseHold('missing'), FreezeError);
  assert.throws(() => engine.undo(), FreezeError);
});
