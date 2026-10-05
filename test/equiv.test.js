import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

// Acceptance 1: reordered events with the same partial order -> EQUAL.
test('reordered events, same partial order -> EQUAL', () => {
  const s = new Store();
  s.ingest('a', [
    { id: 'e1' },
    { id: 'e2', preds: ['e1'] },
    { id: 'e3', preds: ['e2'] },
    { id: 'e4', preds: ['e2'] },
  ]);
  // shuffled order + a redundant transitive edge (e1 -> e3) that changes nothing
  s.ingest('b', [
    { id: 'e4', preds: ['e2'] },
    { id: 'e3', preds: ['e2', 'e1'] },
    { id: 'e1' },
    { id: 'e2', preds: ['e1'] },
  ]);
  assert.equal(s.equiv('a', 'b').status, 'EQUAL');
});

// Acceptance 2: one missing causal edge -> UNDECIDED (missing info, not conflict).
test('one missing causal edge -> UNDECIDED with missing_edges', () => {
  const s = new Store();
  s.ingest('full', [
    { id: 'a' },
    { id: 'b', preds: ['a'] },
    { id: 'c', preds: ['b'] },
  ]);
  s.ingest('missing', [
    { id: 'a' },
    { id: 'b', preds: ['a'] },
    { id: 'c' }, // edge b -> c not yet synced
  ]);
  const r = s.equiv('full', 'missing');
  assert.equal(r.status, 'UNDECIDED');
  assert.ok(r.missing_edges.some((e) => e.from === 'b' && e.to === 'c' && e.missing_in === 'b'));
});

// A reversed causal edge is a positive contradiction -> NOT_EQUAL.
test('reversed causal edge -> NOT_EQUAL with first_divergent and minimal_frontier', () => {
  const s = new Store();
  s.ingest('a', [{ id: 'x' }, { id: 'y', preds: ['x'] }]);
  s.ingest('b', [{ id: 'y' }, { id: 'x', preds: ['y'] }]);
  const r = s.equiv('a', 'b');
  assert.equal(r.status, 'NOT_EQUAL');
  assert.equal(r.first_divergent.type, 'order');
  assert.deepEqual(r.first_divergent.pair, ['x', 'y']);
  assert.ok(Array.isArray(r.minimal_frontier));
  assert.ok(r.minimal_frontier.length >= 1);
  // frontier is a witness path of direct edges
  for (const e of r.minimal_frontier) {
    assert.ok(typeof e.from === 'string' && typeof e.to === 'string');
  }
});

// Acceptance 3: cyclic logs collapse to the same SCC -> EQUAL after compression.
test('cyclic logs equivalent after SCC compression', () => {
  const s = new Store();
  s.ingest('cyc1', [
    { id: 'a', preds: ['c'] },
    { id: 'b', preds: ['a'] },
    { id: 'c', preds: ['b'] },
    { id: 'in' },
    { id: 'a2', preds: ['in', 'a'] },
    { id: 'out', preds: ['c'] },
  ]);
  // same cycle traversed the other way around + different redundant edges
  s.ingest('cyc2', [
    { id: 'out', preds: ['b'] },
    { id: 'c', preds: ['a'] },
    { id: 'b', preds: ['c'] },
    { id: 'a', preds: ['b'] },
    { id: 'in' },
    { id: 'a2', preds: ['in', 'c'] },
  ]);
  assert.equal(s.equiv('cyc1', 'cyc2').status, 'EQUAL');
});

test('cyclic vs acyclic sublog -> UNDECIDED (nested, missing info)', () => {
  const s = new Store();
  s.ingest('cyc', [{ id: 'a', preds: ['b'] }, { id: 'b', preds: ['a'] }]);
  s.ingest('acyc', [{ id: 'a' }, { id: 'b', preds: ['a'] }]);
  // the acyclic log only lacks edges the cyclic one has; no positive contradiction
  assert.equal(s.equiv('cyc', 'acyc').status, 'UNDECIDED');
});

test('state payload conflict on shared event -> NOT_EQUAL (state)', () => {
  const s = new Store();
  s.ingest('a', [{ id: 'e', state: { valve: 'open' } }]);
  s.ingest('b', [{ id: 'e', state: { valve: 'closed' } }]);
  const r = s.equiv('a', 'b');
  assert.equal(r.status, 'NOT_EQUAL');
  assert.equal(r.first_divergent.type, 'state');
  assert.equal(r.first_divergent.event, 'e');
});

test('merge of two shifts equals directly recorded combined log', () => {
  const s = new Store();
  s.ingest('shift1', [{ id: 'e1' }, { id: 'e2', preds: ['e1'] }]);
  s.ingest('shift2', [{ id: 'e3', preds: ['e2'] }, { id: 'e4', preds: ['e2'] }]);
  const m = s.merge('handover', ['shift1', 'shift2']);
  assert.equal(m.status, 'OK');
  s.ingest('combined', [
    { id: 'e1' },
    { id: 'e2', preds: ['e1'] },
    { id: 'e3', preds: ['e2'] },
    { id: 'e4', preds: ['e2'] },
  ]);
  assert.equal(s.equiv('handover', 'combined').status, 'EQUAL');
});

test('merge with conflicting state payloads -> INVALID_INPUT', () => {
  const s = new Store();
  s.ingest('a', [{ id: 'e', state: 1 }]);
  s.ingest('b', [{ id: 'e', state: 2 }]);
  assert.equal(s.merge('m', ['a', 'b']).status, 'INVALID_INPUT');
});

test('equiv with unknown log_id -> INVALID_INPUT', () => {
  const s = new Store();
  s.ingest('a', []);
  assert.equal(s.equiv('a', 'nope').status, 'INVALID_INPUT');
  assert.equal(s.equiv('nope', 'a').status, 'INVALID_INPUT');
});

test('explain returns boundary snapshots', () => {
  const s = new Store();
  s.ingest('a', [{ id: 'x' }, { id: 'y', preds: ['x'] }]);
  s.ingest('b', [{ id: 'x' }, { id: 'y', preds: ['x'] }]);
  const r = s.explain('a', 'b');
  assert.equal(r.status, 'EQUAL');
  assert.deepEqual(r.boundary_a.sources, ['x']);
  assert.deepEqual(r.boundary_a.sinks, ['y']);
  assert.deepEqual(r.boundary_a, r.boundary_b);
});

test('dangling external reference resolved by the other log -> UNDECIDED', () => {
  const s = new Store();
  s.ingest('a', [{ id: 'e1', preds: ['ghost'] }]); // references unknown event
  s.ingest('b', [{ id: 'ghost' }, { id: 'e1', preds: ['ghost'] }]);
  const r = s.equiv('a', 'b');
  assert.equal(r.status, 'UNDECIDED');
  assert.ok(r.missing_edges.some((e) => e.from === 'ghost'));
});
