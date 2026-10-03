import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

// Acceptance 3: equal value + equal window ties break by target ID.
test('equal value and window ties break by target id', () => {
  const store = new Store();
  store.applyAll([
    { type: 'plan', target: 'T-B', pi: 'p', window: [0, 10], value: 5, clock: 1 },
    { type: 'plan', target: 'T-A', pi: 'p', window: [0, 10], value: 5, clock: 2 },
  ]);
  const { sequence, skipped } = store.schedule();
  assert.equal(sequence.length, 1);
  assert.equal(sequence[0].target, 'T-A');
  assert.deepEqual(skipped.map((s) => s.target), ['T-B']);
});

// Acceptance 2: correction invalidating a scheduled target cascades a
// reschedule, but confirmed observations stay unchanged.
test('correction cascades reschedule; confirmed observations unchanged', () => {
  const store = new Store();
  store.applyAll([
    { type: 'plan', target: 'A', pi: 'p1', window: [0, 10], value: 10, switch: 0, clock: 1 },
    { type: 'plan', target: 'B', pi: 'p2', window: [10, 30], value: 11, switch: 0, clock: 2 },
    { type: 'plan', target: 'C', pi: 'p3', window: [10, 20], value: 5, switch: 0, clock: 3 },
    { type: 'plan', target: 'D', pi: 'p3', window: [20, 30], value: 5, switch: 0, clock: 4 },
    { type: 'observe', target: 'A', obs: 'O1', window: [0, 10], clock: 5 },
  ]);
  let r = store.schedule();
  assert.deepEqual(
    r.sequence.map((s) => s.target),
    ['A', 'B'],
    'B wins its slot before the correction',
  );
  store.applyAll([{ type: 'correct', target: 'B', closed: true, clock: 6 }]);
  r = store.schedule();
  const a = r.sequence.find((s) => s.target === 'A');
  assert.deepEqual([a.start, a.end, a.status], [0, 10, 'confirmed'], 'confirmed obs untouched');
  assert.deepEqual(
    r.sequence.filter((s) => s.status === 'scheduled').map((s) => s.target),
    ['C', 'D'],
    'freed slot is cascaded to C and D',
  );
  assert.ok(r.skipped.some((s) => s.target === 'B' && s.reason === 'window-closed'));
});

test('unknown cloud stays pending, never treated as unsatisfiable', () => {
  const store = new Store();
  store.applyAll([
    { type: 'plan', target: 'A', pi: 'p1', window: [0, 10], value: 10, cloud: 'unknown', clock: 1 },
    { type: 'plan', target: 'B', pi: 'p2', window: [20, 30], value: 5, clock: 2 },
  ]);
  let r = store.schedule();
  assert.deepEqual(r.pending, [{ target: 'A', reason: 'cloud-unknown' }]);
  assert.ok(!r.skipped.some((s) => s.target === 'A'), 'pending target is not skipped');
  assert.ok(!r.sequence.some((s) => s.target === 'A'), 'pending target is not scheduled');
  store.applyAll([{ type: 'correct', target: 'A', cloud: 'clear', clock: 3 }]);
  r = store.schedule();
  assert.equal(r.pending.length, 0);
  assert.ok(r.sequence.some((s) => s.target === 'A' && s.status === 'scheduled'));
});

test('preemption happens at correction boundary and saves interruption evidence', () => {
  const store = new Store();
  store.applyAll([
    { type: 'plan', target: 'T', pi: 'p1', window: [0, 100], value: 10, clock: 1 },
    { type: 'observe', target: 'T', obs: 'O1', window: [0, 60], clock: 2 },
    { type: 'correct', target: 'T', window: [0, 30], clock: 3 },
  ]);
  const r = store.schedule();
  const o = r.sequence.find((s) => s.obs === 'O1');
  assert.deepEqual([o.start, o.end], [0, 30], 'observation truncated at the boundary');
  assert.equal(r.evidence.length, 1);
  assert.deepEqual(r.evidence[0], {
    type: 'interrupted',
    obs: 'O1',
    target: 'T',
    original: [0, 60],
    truncated: [0, 30],
    at: 30,
    reason: 'cloud-correction',
  });
});

test('revoke frees the slot and triggers cascade reschedule', () => {
  const store = new Store();
  store.applyAll([
    { type: 'plan', target: 'A', pi: 'p1', window: [0, 10], value: 10, clock: 1 },
    { type: 'plan', target: 'B', pi: 'p2', window: [0, 10], value: 5, clock: 2 },
    { type: 'observe', target: 'A', obs: 'O1', window: [0, 10], clock: 3 },
  ]);
  let r = store.schedule();
  assert.deepEqual(r.sequence.map((s) => [s.target, s.status]), [['A', 'confirmed']]);
  store.applyAll([{ type: 'revoke', obs: 'O1', clock: 4 }]);
  r = store.schedule();
  assert.deepEqual(r.sequence.map((s) => [s.target, s.status]), [['A', 'scheduled']]);
});

test('concurrent history merges deterministically by (clock, node, target)', () => {
  const events = [
    { type: 'plan', target: 'A', pi: 'p1', window: [0, 10], value: 10, clock: 1, node: 'n2' },
    { type: 'plan', target: 'B', pi: 'p2', window: [0, 10], value: 10, clock: 1, node: 'n1' },
    { type: 'plan', target: 'C', pi: 'p3', window: [12, 20], value: 7, clock: 2, node: 'n1' },
    { type: 'observe', target: 'C', obs: 'O1', window: [12, 18], clock: 3, node: 'n2' },
    { type: 'correct', target: 'A', window: [0, 8], clock: 4, node: 'n1' },
  ];
  const shuffled = [events[3], events[1], events[4], events[0], events[2]];
  const s1 = new Store();
  s1.applyAll(events);
  const s2 = new Store();
  s2.applyAll(shuffled);
  assert.deepEqual(s1.log, s2.log, 'merged order depends only on (clock, node, target)');
  assert.equal(s1.certificate().sha256, s2.certificate().sha256);
});
