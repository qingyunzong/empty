import test from 'node:test';
import assert from 'node:assert/strict';
import { planSchedule } from '../src/scheduler.js';

const base = {
  capacity: 10,
  institutions: { A: { quota: 10 }, B: { quota: 10 } },
};

test('atomic group larger than the window is rejected with ATOMIC_SPLIT', () => {
  assert.throws(
    () => planSchedule({ ...base, batches: [{ id: 'g1', institution: 'A', amount: 11, atomic: true }] }),
    (err) => err.code === 'ATOMIC_SPLIT',
  );
});

test('atomic group is never split across rounds', () => {
  const { rounds } = planSchedule({
    ...base,
    batches: [
      { id: 'f1', institution: 'A', priority: 0, amount: 8 },
      { id: 'g1a', institution: 'B', priority: 0, amount: 4, group: 'g1' },
      { id: 'g1b', institution: 'B', priority: 0, amount: 4, group: 'g1' },
    ],
  });
  assert.equal(rounds.length, 2);
  assert.deepEqual(rounds[0].allocations, [{ batch: 'f1', institution: 'A', amount: 8 }]);
  const groupAllocs = rounds[1].allocations.filter((a) => a.group === 'g1');
  assert.equal(groupAllocs.length, 2);
  assert.equal(groupAllocs.reduce((s, a) => s + a.amount, 0), 8);
});

test('high priority atomic group preempts low priority fluid remainder', () => {
  const { rounds } = planSchedule({
    ...base,
    batches: [
      { id: 'f1', institution: 'A', priority: 1, amount: 10 },
      { id: 'g1', institution: 'B', priority: 9, amount: 6, atomic: true },
    ],
  });
  const r1 = Object.fromEntries(rounds[0].allocations.map((a) => [a.batch, a.amount]));
  assert.equal(r1.g1, 6);
  assert.equal(r1.f1, 4);
  assert.equal(rounds[1].allocations[0].batch, 'f1');
  assert.equal(rounds[1].allocations[0].amount, 6);
});

test('confirmed atomic allocations are never preempted', () => {
  const { rounds } = planSchedule({
    ...base,
    batches: [
      { id: 'g0', institution: 'A', priority: 1, amount: 10, atomic: true },
      { id: 'g1', institution: 'B', priority: 9, amount: 6, atomic: true },
    ],
  });
  assert.deepEqual(rounds[0].allocations.map((a) => a.batch), ['g0']);
  assert.deepEqual(rounds[1].allocations.map((a) => a.batch), ['g1']);
});

test('high priority fluid batch preempts low priority fluid batch', () => {
  const { rounds } = planSchedule({
    ...base,
    batches: [
      { id: 'f1', institution: 'A', priority: 1, amount: 10 },
      { id: 'f2', institution: 'B', priority: 9, amount: 6 },
    ],
  });
  const r1 = Object.fromEntries(rounds[0].allocations.map((a) => [a.batch, a.amount]));
  assert.equal(r1.f2, 6);
  assert.equal(r1.f1, 4);
});
