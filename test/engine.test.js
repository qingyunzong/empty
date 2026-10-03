import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, EngineError } from '../src/engine.js';
import { addDays } from '../src/dates.js';

function makeEngine({ skipWeekends = true } = {}) {
  const e = new Engine();
  e.setCalendar({ version: 'v1', holidays: [], skipWeekends });
  return e;
}

function tasksOf(e) {
  return [...e.tasks.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}

test('leap-year boundary: monthly schedule anchored on Jan 31', () => {
  const e = makeEngine({ skipWeekends: false });
  e.addRule({ id: 'm1', freq: 'monthly', interval: 1 });
  e.addContract({ id: 'L1', type: 'loan', start: '2024-01-31', end: '2024-04-30', ruleId: 'm1', amount: 100 });
  assert.deepEqual(tasksOf(e).map((t) => t.due), ['2024-01-31', '2024-02-29', '2024-03-31', '2024-04-30']);

  const e2 = makeEngine({ skipWeekends: false });
  e2.addRule({ id: 'm1', freq: 'monthly', interval: 1 });
  e2.addContract({ id: 'L2', type: 'loan', start: '2025-01-31', end: '2025-03-31', ruleId: 'm1', amount: 7 });
  assert.deepEqual(tasksOf(e2).map((t) => t.due), ['2025-01-31', '2025-02-28', '2025-03-31']);
});

test('weekend settlement shifts forward deterministically', () => {
  const e = makeEngine(); // skipWeekends on
  e.addRule({ id: 'm1', freq: 'monthly', interval: 1 });
  e.addContract({ id: 'S1', type: 'subscription', start: '2024-03-31', end: '2024-03-31', ruleId: 'm1', amount: 9 });
  const [t] = tasksOf(e);
  assert.equal(t.due, '2024-03-31'); // Sunday
  assert.equal(t.date, '2024-04-01'); // settled Monday
});

test('revoke then restore regenerates the identical task set (no loss, no dup)', () => {
  const e = makeEngine({ skipWeekends: false });
  e.addRule({ id: 'd1', freq: 'daily', interval: 1 });
  e.addContract({ id: 'C1', type: 'loan', start: '2024-01-01', end: '2024-01-10', ruleId: 'd1', amount: 50 });
  const before = JSON.parse(JSON.stringify(tasksOf(e)));
  assert.equal(before.length, 10);

  const revokeDiff = e.revokeContract('C1');
  assert.equal(revokeDiff.removed.length, 10);
  assert.equal(e.tasks.size, 0);

  const restoreDiff = e.restoreContract('C1');
  assert.equal(restoreDiff.added.length, 10);
  assert.deepEqual(tasksOf(e), before);

  const again = e.restoreContract('C1'); // idempotent
  assert.equal(again.added.length, 0);
  assert.equal(again.removed.length, 0);
});

test('calendar switch cascades to tasks and batches, switching back restores', () => {
  const e = makeEngine();
  e.addRule({ id: 'm1', freq: 'monthly', interval: 1 });
  e.addContract({ id: 'C1', type: 'subscription', start: '2024-06-10', end: '2024-07-10', ruleId: 'm1', amount: 20 });
  assert.ok(e.batches.has('B@2024-06-10')); // Monday

  const d1 = e.setCalendar({ version: 'v2', holidays: ['2024-06-10'] });
  assert.deepEqual(d1.removed, ['C1#0']);
  assert.equal(d1.added.length, 1);
  assert.equal(d1.added[0].date, '2024-06-11');
  assert.deepEqual(d1.batches.invalidated, ['B@2024-06-10']);
  assert.deepEqual(d1.batches.added, ['B@2024-06-11']);
  assert.ok(!e.batches.has('B@2024-06-10'));
  assert.deepEqual(e.batches.get('B@2024-06-11').tasks, ['C1#0']);

  const d2 = e.setCalendar({ version: 'v1', holidays: [] });
  assert.equal(d2.added[0].date, '2024-06-10');
  assert.deepEqual(d2.batches.invalidated, ['B@2024-06-11']);
  assert.ok(e.batches.has('B@2024-06-10'));
});

test('small-scale enumeration cross-check (daily interval 3 over leap day)', () => {
  const e = makeEngine({ skipWeekends: false });
  e.addRule({ id: 'd3', freq: 'daily', interval: 3 });
  e.addContract({ id: 'E1', type: 'loan', start: '2024-02-26', end: '2024-03-10', ruleId: 'd3', amount: 3 });
  const expected = [];
  for (let d = '2024-02-26'; d <= '2024-03-10'; d = addDays(d, 3)) expected.push(d);
  assert.deepEqual(tasksOf(e).map((t) => t.due), expected);
  assert.ok(expected.includes('2024-02-29'));
});

test('debited tasks are immutable; revoke produces reversal (冲正) only', () => {
  const e = makeEngine({ skipWeekends: false });
  e.addRule({ id: 'd1', freq: 'daily', interval: 1 });
  e.addContract({ id: 'C1', type: 'loan', start: '2024-01-01', end: '2024-01-05', ruleId: 'd1', amount: 50 });
  e.debitBatch('2024-01-01');
  assert.equal(e.tasks.get('C1#0').status, 'debited');
  assert.equal(e.batches.get('B@2024-01-01').status, 'debited');

  const diff = e.revokeContract('C1');
  assert.deepEqual(diff.removed.sort(), ['C1#1', 'C1#2', 'C1#3', 'C1#4']);
  assert.equal(diff.reversals.length, 1);
  const rev = diff.reversals[0];
  assert.equal(rev.key, 'C1#0#R');
  assert.equal(rev.amount, -50);
  assert.equal(rev.date, '2024-01-01');
  assert.equal(e.tasks.get('C1#0').status, 'debited'); // untouched

  // Calendar change must not move the debited task.
  e.setCalendar({ version: 'v2', holidays: ['2024-01-01'], skipWeekends: false });
  assert.equal(e.tasks.get('C1#0').date, '2024-01-01');

  // Restore: debited task is not duplicated, reversal stays on the books.
  e.restoreContract('C1');
  assert.equal(e.tasks.get('C1#0').status, 'debited');
  assert.equal(e.tasks.get('C1#0#R').kind, 'reversal');
  assert.equal(e.tasks.get('C1#1').status, 'pending');
  assert.equal([...e.tasks.values()].filter((t) => t.key === 'C1#0').length, 1);
});

test('BAD_RANGE: end before start is an error, never a silent empty plan', () => {
  const e = makeEngine();
  e.addRule({ id: 'm1', freq: 'monthly', interval: 1 });
  assert.throws(
    () => e.addContract({ id: 'B1', start: '2024-05-01', end: '2024-04-01', ruleId: 'm1', amount: 1 }),
    (err) => err instanceof EngineError && err.code === 'BAD_RANGE',
  );
  assert.equal(e.tasks.size, 0);
  assert.equal(e.contracts.size, 0);
});

test('same-date tasks are ordered by contractId then period', () => {
  const e = makeEngine({ skipWeekends: false });
  e.addRule({ id: 'd1', freq: 'daily', interval: 1 });
  e.addContract({ id: 'C2', type: 'loan', start: '2024-01-01', end: '2024-01-02', ruleId: 'd1', amount: 1 });
  e.addContract({ id: 'C1', type: 'loan', start: '2024-01-01', end: '2024-01-02', ruleId: 'd1', amount: 1 });
  assert.deepEqual(e.batches.get('B@2024-01-01').tasks, ['C1#0', 'C2#0']);
  assert.deepEqual(e.batches.get('B@2024-01-02').tasks, ['C1#1', 'C2#1']);
});

test('dynamic topology: rule upsert recomputes, removal of used rule rejected', () => {
  const e = makeEngine({ skipWeekends: false });
  e.addRule({ id: 'm1', freq: 'monthly', interval: 1 });
  e.addContract({ id: 'C1', type: 'loan', start: '2024-01-15', end: '2024-06-15', ruleId: 'm1', amount: 10 });
  assert.equal(e.tasks.size, 6);

  const diff = e.addRule({ id: 'm1', freq: 'monthly', interval: 2 }); // replace rule
  assert.equal(e.tasks.size, 3);
  assert.deepEqual(diff.removed.sort(), ['C1#1', 'C1#2', 'C1#3', 'C1#4', 'C1#5']);
  assert.deepEqual(diff.added.map((t) => t.key).sort(), ['C1#1', 'C1#2']);
  assert.deepEqual(tasksOf(e).map((t) => t.due), ['2024-01-15', '2024-03-15', '2024-05-15']);

  assert.throws(() => e.removeRule('m1'), (err) => err.code === 'RULE_IN_USE');
  e.revokeContract('C1');
  const d = e.removeRule('m1');
  assert.equal(d.proof.tasks, 0);
});

test('proof hash is deterministic and changes with state', () => {
  const build = () => {
    const e = makeEngine({ skipWeekends: false });
    e.addRule({ id: 'd1', freq: 'daily', interval: 1 });
    e.addContract({ id: 'C1', type: 'loan', start: '2024-01-01', end: '2024-01-03', ruleId: 'd1', amount: 5 });
    return e;
  };
  assert.equal(build().stateHash(), build().stateHash());
  const e = build();
  const h = e.stateHash();
  e.revokeContract('C1');
  assert.notEqual(e.stateHash(), h);
});
