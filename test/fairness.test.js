'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore, applyEvent } = require('../src/biobank');

// Acceptance 2: after the project quota is exhausted, low-priority samples
// wait, and high-priority arrivals cannot jump the queue forever.
const config = {
  type: 'config',
  racks: [{ id: 'R1', zone: '-80', capacity: 2 }],
  quotas: { P1: 1 },
  aging: 1,
  freezeAfter: 5,
};

function arrive(id, priority, arrival) {
  return { type: 'arrive', id, project: 'P1', priority, zone: '-80', arrival, deadline: 1000 };
}

test('quota exhausted: bounded preemption, no infinite queue jumping', () => {
  const store = createStore(config);

  let r = applyEvent(store, arrive('A', 5, 0));
  assert.deepEqual(r.placements.map((p) => p.id), ['A']);

  r = applyEvent(store, arrive('B', 1, 1));
  assert.deepEqual(r.waiting, [{ id: 'B', reason: 'quota_exceeded' }]);

  // C preempts A (unfrozen, lower priority, never preempted before).
  r = applyEvent(store, arrive('C', 9, 2));
  assert.deepEqual(r.preemptions, [{ by: 'C', withdrawn: 'A' }]);
  assert.deepEqual(r.placements.map((p) => p.id), ['C']);
  assert.equal(store.samples.get('A').status, 'waiting');
  assert.equal(store.samples.get('A').preempts, 1);

  // D has equal priority to C: cannot preempt, must wait.
  r = applyEvent(store, arrive('D', 9, 3));
  assert.deepEqual(r.preemptions, []);
  assert.deepEqual(r.placements, []);

  // E arrives after C has frozen (placed at t=2, freezeAfter=5): cannot preempt.
  r = applyEvent(store, arrive('E', 9, 10));
  assert.deepEqual(r.preemptions, []);
  assert.deepEqual(r.placements, []);

  // Even higher priority arrivals cannot displace frozen C: no infinite jumping.
  for (const [id, t] of [['F', 11], ['G', 12]]) {
    r = applyEvent(store, arrive(id, 10, t));
    assert.deepEqual(r.preemptions, []);
    assert.deepEqual(r.placements, []);
  }
  assert.equal(store.samples.get('C').status, 'placed');
  assert.equal(store.samples.get('A').preempts, 1, 'A shielded after one withdrawal');

  // Fairness order: effective key = arrival - priority * aging, ties by id.
  // D: 3-9=-6, A: 0-5=-5, B: 1-1=0, E: 10-9=1, F: 11-10=1, G: 12-10=2
  assert.deepEqual(r.waiting.map((w) => w.id), ['D', 'A', 'B', 'E', 'F', 'G']);
});

test('withdrawn sample keeps original arrival for fairness and is shielded', () => {
  const cfg = {
    type: 'config',
    racks: [{ id: 'R1', zone: '-80', capacity: 1 }],
    quotas: {},
    aging: 1,
    freezeAfter: 100,
  };
  const store = createStore(cfg);
  applyEvent(store, arrive('X', 1, 0));
  const r = applyEvent(store, arrive('Y', 9, 1));
  assert.deepEqual(r.preemptions, [{ by: 'Y', withdrawn: 'X' }]);
  // X is back in the waiting list with its original arrival (0), shielded.
  const x = store.samples.get('X');
  assert.equal(x.status, 'waiting');
  assert.equal(x.arrival, 0);
  assert.equal(x.preempts, 1);
  // A later arrival cannot preempt X again once X is re-placed; and cannot
  // preempt Y (equal-or-higher priority required).
  const r2 = applyEvent(store, arrive('Z', 9, 2));
  assert.deepEqual(r2.preemptions, []);
});
