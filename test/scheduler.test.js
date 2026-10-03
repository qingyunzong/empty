'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Scheduler } = require('../src/scheduler');
const { CODES } = require('../src/errors');

const task = (id, over = {}) => ({
  taskId: id, merchantId: 'm1', severity: 1,
  deadline: '2026-10-04T23:59:59Z', undoable: true, ...over,
});

test('respects slot bound and throws NO_SLOT when full and nothing preemptible', () => {
  const s = new Scheduler({ slots: 1 });
  s.acquire(task('a', { undoable: false }));
  assert.throws(() => s.acquire(task('b', { severity: 9 })), (e) => e.code === CODES.NO_SLOT);
});

test('preempts only undoable lower-priority tasks', () => {
  const s = new Scheduler({ slots: 2 });
  s.acquire(task('low', { severity: 1, undoable: true }));
  s.acquire(task('fixed', { severity: 1, undoable: false, taskId: 'fixed' }));
  const out = {};
  const result = s.acquire(task('urgent', { severity: 3 }), out);
  assert.equal(result, 'preempted');
  assert.equal(out.preempted.taskId, 'low'); // the undoable one, not 'fixed'
  assert.deepEqual(s.runningTasks().map((t) => t.taskId), ['urgent', 'fixed']);
});

test('does not preempt equal-or-higher priority tasks', () => {
  const s = new Scheduler({ slots: 1 });
  s.acquire(task('a', { severity: 5 }));
  assert.throws(() => s.acquire(task('b', { severity: 5 })), (e) => e.code === CODES.NO_SLOT);
  assert.throws(() => s.acquire(task('c', { severity: 4 })), (e) => e.code === CODES.NO_SLOT);
});

test('earlier deadline wins within same severity', () => {
  const s = new Scheduler({ slots: 1 });
  s.acquire(task('late', { deadline: '2026-10-05T00:00:00Z' }));
  const out = {};
  s.acquire(task('early', { deadline: '2026-10-04T00:00:00Z' }), out);
  assert.equal(out.preempted.taskId, 'late');
});

test('enforces merchant quota', () => {
  const s = new Scheduler({ slots: 4, merchantQuota: { m1: 1 } });
  s.acquire(task('a', { merchantId: 'm1' }));
  assert.throws(() => s.acquire(task('b', { merchantId: 'm1' })), (e) => e.code === CODES.NO_SLOT);
  s.acquire(task('c', { merchantId: 'm2' })); // other merchant unaffected
  assert.equal(s.runningTasks().length, 2);
});

test('release frees slots', () => {
  const s = new Scheduler({ slots: 1 });
  s.acquire(task('a', { undoable: false }));
  s.release('a');
  s.acquire(task('b', { undoable: false }));
  assert.equal(s.runningTasks()[0].taskId, 'b');
});
