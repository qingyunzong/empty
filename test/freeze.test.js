import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CycleError,
  FreezeError,
  addHold,
  computeClosure,
  createState,
  deserializeState,
  loadGraph,
  queryLot,
  reachableFrom,
  releaseHold,
  serializeState,
  undo,
} from '../src/freeze.js';

function mergeGraph() {
  return {
    lots: ['A', 'B', 'M', 'P'],
    edges: [
      { child: 'M', parent: 'A' },
      { child: 'M', parent: 'B' },
      { child: 'P', parent: 'M' },
    ],
  };
}

test('acceptance 1: merged lot sees union of upstream and downstream hold reasons', () => {
  const state = createState();
  loadGraph(state, mergeGraph());
  addHold(state, { id: 'h-sup', lot: 'A', type: 'supplier', severity: 3 });
  addHold(state, { id: 'h-cus', lot: 'P', type: 'customer', severity: 5 });

  const merged = queryLot(state, 'M');
  assert.equal(merged.frozen, true);
  assert.equal(merged.severity, 5);
  assert.deepEqual(merged.reasons, ['h-cus', 'h-sup']);

  const product = queryLot(state, 'P');
  assert.deepEqual(product.reasons, ['h-cus', 'h-sup']);

  const sourceB = queryLot(state, 'B');
  assert.deepEqual(sourceB.reasons, ['h-cus']);
  assert.equal(sourceB.severity, 5);

  const sourceA = queryLot(state, 'A');
  assert.deepEqual(sourceA.reasons, ['h-cus', 'h-sup']);
});

test('supplier hold propagates downstream over splits to every derived lot', () => {
  const state = createState();
  loadGraph(state, {
    lots: ['R', 'S1', 'S2', 'T'],
    edges: [
      { child: 'S1', parent: 'R' },
      { child: 'S2', parent: 'R' },
      { child: 'T', parent: 'S1' },
    ],
  });
  addHold(state, { id: 'h1', lot: 'R', type: 'supplier', severity: 2 });
  assert.deepEqual(queryLot(state, 'S1').reasons, ['h1']);
  assert.deepEqual(queryLot(state, 'S2').reasons, ['h1']);
  assert.deepEqual(queryLot(state, 'T').reasons, ['h1']);
});

test('acceptance 2: releasing one of two holds keeps the other fully effective', () => {
  const state = createState();
  loadGraph(state, mergeGraph());
  addHold(state, { id: 'h-low', lot: 'A', type: 'supplier', severity: 2 });
  addHold(state, { id: 'h-high', lot: 'A', type: 'supplier', severity: 7 });

  let result = queryLot(state, 'M');
  assert.equal(result.severity, 7);
  assert.deepEqual(result.reasons, ['h-high', 'h-low']);

  releaseHold(state, 'h-high');
  result = queryLot(state, 'M');
  assert.equal(result.frozen, true);
  assert.equal(result.severity, 2);
  assert.deepEqual(result.reasons, ['h-low']);

  releaseHold(state, 'h-low');
  result = queryLot(state, 'M');
  assert.equal(result.frozen, false);
  assert.deepEqual(result.reasons, []);
});

test('undo restores a released hold and reverses a fresh hold', () => {
  const state = createState();
  loadGraph(state, mergeGraph());
  addHold(state, { id: 'h1', lot: 'A', type: 'supplier', severity: 4 });
  releaseHold(state, 'h1');
  assert.equal(queryLot(state, 'M').frozen, false);

  const undone = undo(state);
  assert.equal(undone.op, 'release');
  assert.equal(queryLot(state, 'M').frozen, true);
  assert.deepEqual(queryLot(state, 'M').reasons, ['h1']);
  assert.equal(queryLot(state, 'M').severity, 4);

  const undoneHold = undo(state);
  assert.equal(undoneHold.op, 'hold');
  assert.equal(queryLot(state, 'A').frozen, false);
  assert.equal(undo(state), null);
});

test('null severity means unknown but still frozen and dominates the max', () => {
  const state = createState();
  loadGraph(state, mergeGraph());
  addHold(state, { id: 'h-num', lot: 'A', type: 'supplier', severity: 9 });
  addHold(state, { id: 'h-null', lot: 'B', type: 'supplier', severity: null });

  const merged = queryLot(state, 'M');
  assert.equal(merged.frozen, true);
  assert.equal(merged.severity, null);
  assert.deepEqual(merged.reasons, ['h-null', 'h-num']);

  releaseHold(state, 'h-null');
  assert.equal(queryLot(state, 'M').severity, 9);
});

test('acceptance 3: cyclic graph is rejected before any transaction with no partial state', () => {
  const state = createState();
  assert.throws(
    () =>
      loadGraph(state, {
        lots: ['A', 'B', 'C'],
        edges: [
          { child: 'A', parent: 'B' },
          { child: 'B', parent: 'C' },
          { child: 'C', parent: 'A' },
        ],
      }),
    CycleError,
  );
  assert.equal(state.loaded, false);
  assert.throws(() => queryLot(state, 'A'), FreezeError);
  assert.throws(() => addHold(state, { id: 'h', lot: 'A', type: 'supplier', severity: 1 }), FreezeError);
});

test('failed reload does not corrupt a previously loaded graph', () => {
  const state = createState();
  loadGraph(state, mergeGraph());
  addHold(state, { id: 'h1', lot: 'A', type: 'supplier', severity: 1 });
  assert.throws(() => loadGraph(state, { edges: [{ child: 'X', parent: 'X' }] }), CycleError);
  assert.deepEqual(queryLot(state, 'M').reasons, ['h1']);
});

test('reachableFrom independently enumerates all reachable nodes', () => {
  const adjacency = new Map([
    ['a', new Set(['b', 'c'])],
    ['b', new Set(['d'])],
    ['c', new Set(['d'])],
    ['d', new Set()],
    ['e', new Set(['a'])],
  ]);
  assert.deepEqual([...reachableFrom('a', adjacency)].sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual([...reachableFrom('e', adjacency)].sort(), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual([...reachableFrom('d', adjacency)], ['d']);
});

test('computeClosure recomputes from scratch so released holds leave no residue', () => {
  const state = createState();
  loadGraph(state, mergeGraph());
  addHold(state, { id: 'h1', lot: 'P', type: 'customer', severity: 6 });
  assert.deepEqual(computeClosure(state).get('B').reasons, ['h1']);
  releaseHold(state, 'h1');
  assert.equal(computeClosure(state).size, 0);
});

test('invalid inputs are rejected', () => {
  const state = createState();
  loadGraph(state, mergeGraph());
  assert.throws(() => addHold(state, { id: 'x', lot: 'ZZ', type: 'supplier', severity: 1 }), FreezeError);
  assert.throws(() => addHold(state, { id: 'x', lot: 'A', type: 'vendor', severity: 1 }), FreezeError);
  assert.throws(() => addHold(state, { id: 'x', lot: 'A', type: 'supplier', severity: Number.NaN }), FreezeError);
  addHold(state, { id: 'ok', lot: 'A', type: 'supplier', severity: 1 });
  assert.throws(() => addHold(state, { id: 'ok', lot: 'A', type: 'supplier', severity: 1 }), FreezeError);
  assert.throws(() => releaseHold(state, 'missing'), FreezeError);
  assert.throws(() => queryLot(state, 'ZZ'), FreezeError);
});

test('state survives a serialize/deserialize round trip', () => {
  const state = createState();
  loadGraph(state, mergeGraph());
  addHold(state, { id: 'h1', lot: 'A', type: 'supplier', severity: null });
  releaseHold(state, 'h1');
  const restored = deserializeState(serializeState(state));
  assert.equal(queryLot(restored, 'M').frozen, false);
  undo(restored);
  const merged = queryLot(restored, 'M');
  assert.equal(merged.frozen, true);
  assert.equal(merged.severity, null);
  assert.deepEqual(merged.reasons, ['h1']);
});
