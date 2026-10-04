// Acceptance 2: retracting the erroneous event removes the conflict and the
// restored state produces repeatable results; propagation undo is incremental.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventStore } from '../src/store.js';
import { PrecedenceEngine } from '../src/engine.js';
import { solve } from '../src/solver.js';

const E1 = { id: 'e1', device: 'd1', ts: 0, vc: { d1: 1 }, type: 'RUN' };
const E2 = { id: 'e2', device: 'd1', ts: 1, vc: { d1: 2 }, type: 'STOP' };
// Erroneous event: RUN while the device is stopped (RESET missing).
const E3 = { id: 'e3', device: 'd1', ts: 2, vc: { d1: 3 }, type: 'RUN' };

function baseStore() {
  const store = new EventStore();
  store.add(E1);
  store.add(E2);
  return store;
}

test('STOP-then-RUN without RESET is infeasible with a conflict chain', () => {
  const store = baseStore();
  store.add(E3);
  const result = solve(store, { budget: 1000 });
  assert.equal(result.status, 'infeasible');
  assert.ok(result.conflict.events.includes('e3'));
  assert.ok(result.conflict.events.includes('e2'));
  assert.deepEqual(result.conflict.rules, ['sequence:RUN:requires-ready']);
  assert.match(result.conflict.description, /device d1/);
});

test('retracting the erroneous event restores sat, repeatably', () => {
  const store = baseStore();
  const before = solve(store, { budget: 1000 });
  assert.equal(before.status, 'sat');
  assert.deepEqual(before.order, ['e1', 'e2']);

  store.add(E3);
  assert.equal(solve(store, { budget: 1000 }).status, 'infeasible');

  store.retract('e3');
  const after1 = solve(store, { budget: 1000 });
  const after2 = solve(store, { budget: 1000 });
  assert.equal(after1.status, 'sat');
  assert.deepEqual(after1, before); // state fully restored
  assert.deepEqual(after2, after1); // repeatable

  // Correction cycle (retract + re-add) is also repeatable.
  store.add(E3);
  assert.equal(solve(store, { budget: 1000 }).status, 'infeasible');
  store.retract('e3');
  assert.deepEqual(solve(store, { budget: 1000 }), before);
});

test('engine incrementally undoes propagation on retract', () => {
  const engine = new PrecedenceEngine({});
  engine.addEvent(E1);
  engine.addEvent(E2);
  engine.addEvent(E3);
  assert.equal(engine.reaches('e1', 'e3'), true);
  const edgeCount = [...engine.edges()].length;

  engine.retractEvent('e3');
  assert.equal(engine.reaches('e1', 'e3'), false);
  assert.equal(engine.reaches('e1', 'e2'), true); // surviving facts intact
  assert.ok([...engine.edges()].length < edgeCount);
  assert.deepEqual([...engine.events.keys()].sort(), ['e1', 'e2']);
});

test('trail restores speculative propagation and search nodes', () => {
  const engine = new PrecedenceEngine({});
  engine.addEvent({ id: 'a', device: 'd1', ts: 0, vc: { d1: 1 }, type: 'RUN' });
  engine.addEvent({ id: 'b', device: 'd2', ts: 0, vc: { d2: 1 }, type: 'RUN' });
  assert.equal(engine.reaches('a', 'b'), false); // concurrent

  const mark = engine.begin();
  engine.addDecisionEdge('a', 'b'); // speculate a before b
  assert.equal(engine.reaches('a', 'b'), true);
  const inner = engine.begin();
  engine.addDecisionEdge('b', 'a'); // would create a cycle
  assert.ok(engine.findCycle() !== null);
  engine.rollback(inner); // undo inner speculation
  assert.equal(engine.findCycle(), null);
  assert.equal(engine.reaches('a', 'b'), true);
  engine.rollback(mark); // restore to checkpoint
  assert.equal(engine.reaches('a', 'b'), false);
});
