import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler, compareTasks } from '../src/scheduler.js';
import { ReconError } from '../src/errors.js';

const task = (id, over = {}) => ({
  id,
  merchant: 'm-1',
  severity: 1,
  deadline: '2026-10-03',
  domain: 'acct-1@2026-10-03',
  undoable: true,
  ...over,
});

test('priority order: severity desc, deadline asc, id asc', () => {
  const a = task('a', { severity: 2 });
  const b = task('b', { severity: 3 });
  const c = task('c', { severity: 3, deadline: '2026-10-01' });
  const d = task('d', { severity: 3, deadline: '2026-10-01' });
  assert.ok(compareTasks(b, a) < 0, 'higher severity first');
  assert.ok(compareTasks(c, b) < 0, 'earlier deadline first');
  assert.ok(compareTasks(c, d) < 0, 'id breaks ties');
});

test('slot bound: extra tasks go pending, promote fills freed slots', () => {
  const s = new Scheduler({ slots: 2 });
  assert.equal(s.submit(task('t1')).status, 'running');
  assert.equal(s.submit(task('t2')).status, 'running');
  assert.equal(s.submit(task('t3', { severity: 0 })).status, 'pending');
  s.complete('t1');
  assert.deepEqual(s.promote(), ['t3']);
  assert.equal(s.running.size, 2);
});

test('merchant quota limits concurrent running tasks per merchant', () => {
  const s = new Scheduler({ slots: 4, merchantQuota: 1 });
  assert.equal(s.submit(task('a', { merchant: 'm-1' })).status, 'running');
  assert.equal(s.submit(task('b', { merchant: 'm-1' })).status, 'pending');
  assert.equal(s.submit(task('c', { merchant: 'm-2' })).status, 'running');
});

test('preemption is allowed only against undoable tasks', () => {
  const s = new Scheduler({ slots: 1 });
  s.submit(task('low', { severity: 1, undoable: true }));
  const res = s.submit(task('high', { severity: 9 }));
  assert.equal(res.status, 'running');
  assert.equal(res.preempted, 'low');
  assert.deepEqual(s.pendingIds(), ['low']);
});

test('non-undoable running task cannot be preempted; strict submit raises NO_SLOT', () => {
  const s = new Scheduler({ slots: 1 });
  s.submit(task('critical', { severity: 1, undoable: false }));
  assert.throws(
    () => s.submit(task('high', { severity: 9 }), { strict: true }),
    (e) => e instanceof ReconError && e.code === 'NO_SLOT',
  );
  const res = s.submit(task('high', { severity: 9 }));
  assert.equal(res.status, 'pending');
});

test('preemption does not violate the merchant quota', () => {
  const s = new Scheduler({ slots: 2, merchantQuota: 1 });
  s.submit(task('a', { merchant: 'm-1', severity: 5, undoable: false }));
  s.submit(task('b', { merchant: 'm-2', severity: 1, undoable: true }));
  // m-1 quota is full and a is not undoable; preempting b (m-2) frees no m-1 slot.
  const res = s.submit(task('c', { merchant: 'm-1', severity: 9 }));
  assert.equal(res.status, 'pending');
  // Preempting the same-merchant task keeps the quota satisfied.
  const res2 = s.submit(task('d', { merchant: 'm-2', severity: 9 }));
  assert.equal(res2.status, 'running');
  assert.equal(res2.preempted, 'b');
});

test('strict submit with zero slots raises NO_SLOT', () => {
  const s = new Scheduler({ slots: 0 });
  assert.throws(() => s.submit(task('x'), { strict: true }), (e) => e.code === 'NO_SLOT');
  assert.equal(s.submit(task('x')).status, 'pending');
});

test('same-merchant preemption is allowed when it frees the quota slot', () => {
  const s = new Scheduler({ slots: 2, merchantQuota: 1 });
  s.submit(task('a', { merchant: 'm-1', severity: 5, undoable: true }));
  s.submit(task('b', { merchant: 'm-2', severity: 1, undoable: true }));
  const res = s.submit(task('c', { merchant: 'm-1', severity: 9 }));
  assert.equal(res.status, 'running');
  assert.equal(res.preempted, 'a');
});

test('duplicate task ids are rejected', () => {
  const s = new Scheduler({ slots: 2 });
  s.submit(task('x'));
  assert.throws(() => s.submit(task('x')), (e) => e.code === 'BAD_DIFF');
});
