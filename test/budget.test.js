// Acceptance 3: two concurrent histories + insufficient budget => unknown
// with pending events; propagation-level conflicts are never masked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventStore } from '../src/store.js';
import { solve } from '../src/solver.js';

// Two fully concurrent device histories (incomparable vector clocks,
// timestamps within the skew window => no cross-device precedence).
function concurrentStore() {
  const store = new EventStore();
  store.add({ id: 'a1', device: 'd1', ts: 0, vc: { d1: 1 }, type: 'RUN' });
  store.add({ id: 'a2', device: 'd1', ts: 1, vc: { d1: 2 }, type: 'STOP' });
  store.add({ id: 'b1', device: 'd2', ts: 0, vc: { d2: 1 }, type: 'RUN' });
  store.add({ id: 'b2', device: 'd2', ts: 1, vc: { d2: 2 }, type: 'STOP' });
  return store;
}

test('insufficient budget over concurrent histories returns unknown + pending', () => {
  const store = concurrentStore();
  const result = solve(store, { budget: 1 });
  assert.equal(result.status, 'unknown');
  assert.ok(result.pending.length > 0);
  const devices = new Set(result.pending.map((id) => store.get(id).device));
  assert.ok(devices.has('d1') && devices.has('d2'), 'pending covers both histories');
});

test('budget 0 is unknown even though a solution exists', () => {
  const result = solve(concurrentStore(), { budget: 0 });
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.pending, ['a1', 'a2', 'b1', 'b2']);
});

test('sufficient budget finds a (non-unique) valid interleaving', () => {
  const result = solve(concurrentStore(), { budget: 100000 });
  assert.equal(result.status, 'sat');
  assert.equal(result.unique, false); // several interleavings are legal
  assert.deepEqual([...result.order].sort(), ['a1', 'a2', 'b1', 'b2']);
  // Per-device causal chains are respected in the returned order.
  assert.ok(result.positions.a1 < result.positions.a2);
  assert.ok(result.positions.b1 < result.positions.b2);
});

test('propagation conflict is reported even with budget 0 (never masked by unknown)', () => {
  const store = new EventStore();
  // Vector clock says y < x, but the time window says x < y: hard cycle.
  store.add({ id: 'x', device: 'd1', ts: 0, vc: { d1: 2, d2: 1 }, type: 'RUN' });
  store.add({ id: 'y', device: 'd2', ts: 100000, vc: { d2: 1 }, type: 'RUN' });
  const result = solve(store, { budget: 0, maxSkewMs: 30000 });
  assert.equal(result.status, 'infeasible');
  assert.deepEqual([...result.conflict.events].sort(), ['x', 'y']);
  assert.deepEqual(result.conflict.rules, ['time-window', 'vector-clock']);
  assert.match(result.conflict.description, /cyclic precedence/);
});

test('concurrent histories containing a hard conflict still report it under tiny budget', () => {
  const store = concurrentStore();
  // Add a contradictory pair concurrent with everything else.
  store.add({ id: 'x', device: 'd3', ts: 0, vc: { d3: 2, d4: 1 }, type: 'RUN' });
  store.add({ id: 'y', device: 'd4', ts: 100000, vc: { d4: 1 }, type: 'RUN' });
  const result = solve(store, { budget: 1, maxSkewMs: 30000 });
  assert.equal(result.status, 'infeasible');
  assert.ok(result.conflict.events.includes('x'));
  assert.ok(result.conflict.events.includes('y'));
});
