import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scheduleTasks } from '../src/scheduler.js';

const task = (over) => ({
  accountId: 'x',
  priority: 1,
  gap: 10,
  liqDistance: 5,
  deadlineSlot: 0,
  equity: 90,
  ...over,
});

test('ranks by priority, then gap, then liquidation distance, then account id', () => {
  const tasks = [
    task({ accountId: 'b', priority: 1, gap: 10, deadlineSlot: 4 }),
    task({ accountId: 'a', priority: 2, gap: 1, deadlineSlot: 4 }), // highest priority wins
    task({ accountId: 'c', priority: 1, gap: 20, deadlineSlot: 4 }), // same priority, bigger gap
    task({ accountId: 'd', priority: 1, gap: 20, liqDistance: 1, deadlineSlot: 4 }), // same gap, closer to liquidation
    task({ accountId: 'e', priority: 1, gap: 20, liqDistance: 1, deadlineSlot: 4 }), // full tie -> id asc
  ];
  const { calls } = scheduleTasks(tasks, 5, 1);
  // slot 0..4 assigned in rank order: a, d, e, c, b
  const order = [...calls].sort((x, y) => x.slot - y.slot).map((c) => c.accountId);
  assert.deepEqual(order, ['a', 'd', 'e', 'c', 'b']);
});

test('capacity per slot and NO_CAPACITY when full before deadline', () => {
  const tasks = [
    task({ accountId: 'a', gap: 30, deadlineSlot: 0 }),
    task({ accountId: 'b', gap: 20, deadlineSlot: 1 }),
    task({ accountId: 'c', gap: 10, deadlineSlot: 1 }),
  ];
  const { calls, errors } = scheduleTasks(tasks, 2, 1);
  assert.deepEqual(Object.fromEntries(calls.map((c) => [c.accountId, c.slot])), { a: 0, b: 1 });
  assert.deepEqual(errors, [{ code: 'NO_CAPACITY', accountId: 'c', deadlineSlot: 1 }]);
  // now a single slot only: b and c miss out
  const tight = scheduleTasks(tasks, 1, 1);
  assert.deepEqual(tight.calls.map((c) => c.accountId), ['a']);
  assert.deepEqual(tight.errors, [
    { code: 'NO_CAPACITY', accountId: 'b', deadlineSlot: 1 },
    { code: 'NO_CAPACITY', accountId: 'c', deadlineSlot: 1 },
  ]);
});

test('earliest feasible slot is chosen', () => {
  const { calls } = scheduleTasks([task({ accountId: 'a', deadlineSlot: 3 })], 4, 1);
  assert.equal(calls[0].slot, 0);
});
