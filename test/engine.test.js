import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';

const C = (over = {}) => ({
  op: 'add_contract', id: 'C1', type: 'loan', freq: 'monthly',
  start: '2024-01-31', end: '2024-04-30', amount: 100, ...over,
});

test('add contract generates calendar-adjusted tasks with diff+proof', () => {
  const e = new Engine();
  const r = e.apply(C());
  assert.deepEqual(r.diff.added, ['C1#0', 'C1#1', 'C1#2', 'C1#3']);
  const dates = e.sortedTasks().map((t) => t.dueDate);
  assert.deepEqual(dates, ['2024-01-31', '2024-02-29', '2024-04-01', '2024-04-30']); // 03-31 is a Sunday -> rolls to 04-01
  assert.equal(r.proof.tasks, 4);
});

test('revoke then restore recovers identical future tasks, no dup/missing', () => {
  const e = new Engine();
  const before = e.apply(C()).proof;
  const revoked = e.apply({ op: 'revoke_contract', id: 'C1' });
  assert.deepEqual(revoked.diff.removed, ['C1#0', 'C1#1', 'C1#2', 'C1#3']);
  assert.equal(e.tasks.size, 0);
  const restored = e.apply({ op: 'restore_contract', id: 'C1' });
  assert.deepEqual(restored.diff.added, ['C1#0', 'C1#1', 'C1#2', 'C1#3']);
  assert.deepEqual(restored.proof, before); // hash-identical to pre-revoke state
});

test('paid tasks are immutable: revoke issues reversal instead of deletion', () => {
  const e = new Engine();
  e.apply(C());
  e.apply({ op: 'create_batch', id: 'B1', cutoff: '2024-01-31' });
  e.apply({ op: 'execute_batch', id: 'B1' }); // C1#0 paid
  const r = e.apply({ op: 'revoke_contract', id: 'C1' });
  assert.deepEqual(r.diff.removed, ['C1#1', 'C1#2', 'C1#3']);
  assert.deepEqual(r.diff.reversed, ['REV:C1#0']);
  const paid = e.tasks.get('C1#0');
  assert.equal(paid.status, 'paid'); // untouched
  const rev = e.tasks.get('REV:C1#0');
  assert.equal(rev.amount, -100);
  assert.equal(rev.reverses, 'C1#0');
  // idempotent: further recomputes must not duplicate the reversal
  e.apply({ op: 'add_holiday', date: '2024-06-03' });
  assert.equal([...e.tasks.keys()].filter((k) => k.startsWith('REV:')).length, 1);
});

test('calendar switch cascades to tasks and invalidates open batches', () => {
  const e = new Engine();
  e.apply(C({ id: 'C1', start: '2024-03-01', end: '2024-05-31' }));
  e.apply({ op: 'create_batch', id: 'B1', cutoff: '2024-04-30' });
  assert.deepEqual(e.batches.get('B1').taskIds, ['C1#0', 'C1#1']);
  // backfill a holiday on 2024-03-01: task rolls to next business day
  const r = e.apply({ op: 'add_holiday', date: '2024-03-01' });
  assert.deepEqual(r.diff.updated, [{ id: 'C1#0', from: '2024-03-01', to: '2024-03-04' }]);
  assert.equal(r.proof.calendarVersion, 1);
  // full calendar replacement moves 2024-03-04 too and cascades into batch
  const r2 = e.apply({ op: 'set_calendar', holidays: ['2024-03-01', '2024-03-04', '2024-03-05'] });
  assert.deepEqual(r2.diff.updated, [{ id: 'C1#0', from: '2024-03-04', to: '2024-03-06' }]);
  assert.deepEqual(e.batches.get('B1').taskIds, ['C1#0', 'C1#1']);
  assert.equal(e.tasks.get('C1#0').dueDate, '2024-03-06');
});

test('removed future task propagates out of its open batch', () => {
  const e = new Engine();
  e.apply(C({ id: 'C1', start: '2024-01-15', end: '2024-03-15' }));
  e.apply(C({ id: 'C2', type: 'subscription', start: '2024-01-15', end: '2024-03-15', amount: 7 }));
  e.apply({ op: 'create_batch', id: 'B1', cutoff: '2024-02-01' });
  assert.deepEqual(e.batches.get('B1').taskIds, ['C1#0', 'C2#0']);
  const r = e.apply({ op: 'revoke_contract', id: 'C2' });
  assert.deepEqual(r.batches.B1.removed, ['C2#0']);
  assert.deepEqual(e.batches.get('B1').taskIds, ['C1#0']);
});

test('same-day tasks order by contractId then period', () => {
  const e = new Engine();
  e.apply(C({ id: 'C9', start: '2024-01-15', end: '2024-02-15' }));
  e.apply(C({ id: 'C1', start: '2024-01-15', end: '2024-02-15' }));
  const ids = e.sortedTasks().map((t) => t.id);
  assert.deepEqual(ids, ['C1#0', 'C9#0', 'C1#1', 'C9#1']);
});

test('BAD_RANGE surfaces from engine, no state mutation', () => {
  const e = new Engine();
  assert.throws(() => e.apply(C({ end: '2024-01-01' })), (e2) => e2.code === 'BAD_RANGE');
  assert.equal(e.contracts.size, 0);
  assert.equal(e.tasks.size, 0);
});
