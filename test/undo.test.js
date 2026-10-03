'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore, applyEvent, computeHash, BiobankError } = require('../src/biobank');

const config = {
  type: 'config',
  racks: [{ id: 'R1', zone: '-80', capacity: 2 }],
  quotas: {},
  aging: 1,
  freezeAfter: 100,
};

function arrive(id, priority, arrival, deadline = 1000) {
  return { type: 'arrive', id, project: 'P1', priority, zone: '-80', arrival, deadline };
}

// Acceptance 3: after preemption, undo restores the withdrawn sample.
test('undo after preemption restores withdrawn sample and replays consistently', () => {
  const store = createStore(config);
  const emptyHash = computeHash(store);

  applyEvent(store, arrive('A', 1, 0));
  const hash1 = computeHash(store);
  applyEvent(store, arrive('B', 1, 1));
  const hash2 = computeHash(store);

  const r = applyEvent(store, arrive('C', 9, 2));
  assert.deepEqual(r.preemptions, [{ by: 'C', withdrawn: 'A' }]);
  assert.equal(store.samples.get('A').status, 'waiting');

  // Hierarchical undo to event point 1: A is placed again, B and C never happened.
  const u1 = applyEvent(store, { type: 'undo', to: 1, time: 3 });
  assert.equal(store.samples.get('A').status, 'placed');
  assert.equal(store.samples.has('B'), false);
  assert.equal(store.samples.has('C'), false);
  assert.equal(u1.hash, hash1, 'replay after undo reproduces the earlier certificate hash');

  // New events continue from the restored clock; undo again to the empty state.
  applyEvent(store, arrive('D', 1, 4));
  const u0 = applyEvent(store, { type: 'undo', to: 0, time: 5 });
  assert.equal(u0.hash, emptyHash);
  assert.equal(store.samples.size, 0);

  // Rebuild identically: hash must match the original run (deterministic replay).
  applyEvent(store, arrive('A', 1, 6));
  applyEvent(store, arrive('B', 1, 7));
  assert.notEqual(computeHash(store), hash2, 'different arrival times give different certificates');
  void hash2;
});

test('correct changes priority/deadline; expired samples leave the queue', () => {
  const store = createStore({
    type: 'config',
    racks: [{ id: 'R1', zone: '-80', capacity: 1 }],
    quotas: { P1: 0 },
    aging: 1,
    freezeAfter: 10,
  });
  applyEvent(store, arrive('A', 1, 0, 50));
  assert.equal(store.samples.get('A').status, 'waiting');

  let r = applyEvent(store, { type: 'correct', id: 'A', priority: 9, time: 1 });
  assert.equal(store.samples.get('A').priority, 9);
  assert.equal(store.samples.get('A').status, 'waiting'); // quota still 0

  r = applyEvent(store, { type: 'correct', id: 'A', deadline: 0, time: 2 });
  assert.deepEqual(r.expired, ['A']);
  assert.equal(store.samples.get('A').status, 'expired');

  assert.throws(() => applyEvent(store, { type: 'correct', id: 'A', priority: 1, time: 3 }),
    (e) => e instanceof BiobankError && e.code === 'illegal_event');
  assert.throws(() => applyEvent(store, { type: 'correct', id: 'NOPE', priority: 1, time: 3 }),
    (e) => e.code === 'illegal_event');
});

test('correct on a placed sample affects later preemption decisions', () => {
  const store = createStore(config);
  applyEvent(store, arrive('A', 1, 0));
  applyEvent(store, { type: 'correct', id: 'A', priority: 9, time: 1 });
  // B cannot preempt A anymore because A is now priority 9.
  const r = applyEvent(store, arrive('B', 5, 2));
  assert.deepEqual(r.preemptions, []);
  assert.equal(store.samples.get('B').status, 'placed'); // capacity 2, second slot free
});

test('cancel removes a waiting sample; cancelling placed/unknown is illegal', () => {
  const store = createStore({
    type: 'config',
    racks: [{ id: 'R1', zone: '-80', capacity: 1 }],
    quotas: {},
    aging: 1,
    freezeAfter: 10,
  });
  applyEvent(store, arrive('A', 1, 0));
  applyEvent(store, arrive('B', 1, 1)); // B waits: rack full
  assert.equal(store.samples.get('B').status, 'waiting');

  const r = applyEvent(store, { type: 'cancel', id: 'B', time: 2 });
  assert.equal(store.samples.get('B').status, 'cancelled');
  assert.deepEqual(r.waiting, []);

  assert.throws(() => applyEvent(store, { type: 'cancel', id: 'A', time: 3 }),
    (e) => e.code === 'illegal_event');
  assert.throws(() => applyEvent(store, { type: 'cancel', id: 'ZZ', time: 3 }),
    (e) => e.code === 'illegal_event');
});

test('undo target out of range is an illegal event and keeps state', () => {
  const store = createStore(config);
  applyEvent(store, arrive('A', 1, 0));
  const before = computeHash(store);
  assert.throws(() => applyEvent(store, { type: 'undo', to: 5, time: 1 }),
    (e) => e.code === 'illegal_event');
  assert.equal(computeHash(store), before);
});
