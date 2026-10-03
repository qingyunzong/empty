'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');
const { CODES } = require('../src/errors');

const DAY = '2026-10-04';
const entry = (id, over = {}) => ({
  id, accountId: 'a1', day: DAY, amount: 100, currency: 'CNY', status: 'settled', ...over,
});

function engineWithDiff(over = {}) {
  const engine = new Engine({ slots: 2 });
  engine.loadSnapshot([entry('t1', { amount: 90 })]);
  engine.ingestLedger([entry('t1')]);
  Object.assign(engine, over);
  return engine;
}

test('end-to-end: reconcile -> schedule -> apply -> report', () => {
  const engine = engineWithDiff();
  const tasks = engine.reconcile({});
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].kind, 'AMOUNT_MISMATCH');
  engine.schedulePending();
  engine.applyTask(tasks[0].taskId);
  const report = engine.report();
  assert.deepEqual(report.repaired, [tasks[0].taskId]);
  assert.deepEqual(report.pending, []);
  assert.deepEqual(report.conflicts, []);
  assert.match(report.auditRoot, /^[0-9a-f]{64}$/);
  assert.equal(engine.snapshot.get('t1').amount, 100); // repaired to ledger value
});

test('undo restores snapshot byte-exactly', () => {
  const engine = engineWithDiff();
  const beforeBytes = engine.snapshotBytes();
  const [task] = engine.reconcile({});
  engine.applyTask(task.taskId);
  assert.notEqual(engine.snapshotBytes(), beforeBytes);
  engine.undo(task.taskId);
  assert.equal(engine.snapshotBytes(), beforeBytes); // byte-exact
  assert.deepEqual(engine.report().repaired, []);
});

test('undo of unknown or non-applied repair throws', () => {
  const engine = engineWithDiff();
  assert.throws(() => engine.undo('task-999'));
});

test('same account+day is a conflict domain; stale event rejected', () => {
  const engine = new Engine({ slots: 4 });
  engine.loadSnapshot([entry('t1', { amount: 1 }), entry('t2', { amount: 2 })]);
  engine.ingestLedger([entry('t1'), entry('t2')]);
  const [t1, t2] = engine.reconcile({});
  engine.applyTask(t1.taskId); // lamport 1 in domain a1|DAY
  engine.clock.time = -1;      // simulate a stale/late event arriving out of order
  engine.applyTask(t2.taskId);
  assert.equal(t2.status, 'failed');
  assert.equal(t2.error, CODES.CONFLICT_DOMAIN);
  const report = engine.report();
  assert.deepEqual(report.conflicts, [{ taskId: t2.taskId, domain: `a1|${DAY}` }]);
  assert.deepEqual(report.repaired, [t1.taskId]);
});

test('different domains do not conflict', () => {
  const engine = new Engine({ slots: 4 });
  engine.loadSnapshot([entry('t1', { amount: 1 }), entry('t2', { accountId: 'a2', amount: 2 })]);
  engine.ingestLedger([entry('t1'), entry('t2', { accountId: 'a2' })]);
  const tasks = engine.reconcile({});
  for (const t of tasks) engine.applyTask(t.taskId);
  assert.deepEqual(engine.report().conflicts, []);
  assert.equal(engine.report().repaired.length, 2);
});

test('NO_SLOT: tasks beyond slot capacity stay pending with error', () => {
  const engine = new Engine({ slots: 1 });
  engine.loadSnapshot([entry('t1', { amount: 1, undoable: false }), entry('t2', { amount: 2 })]);
  engine.ingestLedger([entry('t1'), entry('t2')]);
  const tasks = engine.reconcile({});
  for (const t of tasks) t.undoable = false; // nothing preemptible
  engine.schedulePending();
  const started = tasks.filter((t) => t.status === 'running');
  const waiting = tasks.filter((t) => t.status === 'pending');
  assert.equal(started.length, 1);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].error, CODES.NO_SLOT);
});

test('slot preemption only hits undoable tasks and undoes applied work', () => {
  const engine = new Engine({ slots: 1 });
  engine.loadSnapshot([entry('t1', { status: 'pending' }), entry('t2', { amount: 1 })]);
  engine.ingestLedger([entry('t1'), entry('t2')]);
  const tasks = engine.reconcile({});
  const low = tasks.find((t) => t.kind === 'STATUS_MISMATCH');  // severity 1
  const high = tasks.find((t) => t.kind === 'AMOUNT_MISMATCH'); // severity 3
  const bytesBefore = engine.snapshotBytes();
  engine.applyTask(low.taskId); // holds the only slot, applied
  assert.notEqual(engine.snapshotBytes(), bytesBefore);
  engine.applyTask(high.taskId); // must preempt low: undo it, then apply
  assert.equal(engine.tasks.get(low.taskId).status, 'pending');
  assert.equal(engine.tasks.get(high.taskId).status, 'applied');
  // low's repair was undone; only high's effect remains
  assert.equal(engine.snapshot.get('t1').status, 'pending');
  assert.equal(engine.snapshot.get('t2').amount, 100);
});

test('non-undoable running task cannot be preempted (NO_SLOT)', () => {
  const engine = new Engine({ slots: 1 });
  engine.loadSnapshot([entry('t1', { status: 'pending' }), entry('t2', { amount: 1 })]);
  engine.ingestLedger([entry('t1'), entry('t2')]);
  const tasks = engine.reconcile({});
  const low = tasks.find((t) => t.kind === 'STATUS_MISMATCH');
  const high = tasks.find((t) => t.kind === 'AMOUNT_MISMATCH');
  low.undoable = false;
  engine.applyTask(low.taskId);  // low takes the only slot and is not undoable
  engine.applyTask(high.taskId); // cannot preempt -> stays pending with NO_SLOT
  assert.equal(engine.tasks.get(high.taskId).status, 'pending');
  assert.equal(engine.tasks.get(high.taskId).error, CODES.NO_SLOT);
});

test('sealed day rejects late ledger via engine, supersedes chain accepted', () => {
  const engine = new Engine({ slots: 1 });
  engine.ingestLedger([entry('t1')]);
  engine.sealDay('a1', DAY);
  assert.throws(() => engine.ingestLedger([entry('tLate')]), (e) => e.code === CODES.SEALED);
  const accepted = engine.ingestLedger([entry('t2', { supersedes: 't1', amount: 777 })]);
  assert.deepEqual(accepted, ['t2']);
  assert.equal(engine.ledger.has('t1'), false); // superseded entry replaced
  assert.equal(engine.ledger.get('t2').amount, 777);
});

test('merchant quota keeps excess tasks pending', () => {
  const engine = new Engine({ slots: 8, merchantQuota: { m1: 1 } });
  engine.loadSnapshot([entry('t1', { amount: 1 }), entry('t2', { amount: 2 })]);
  engine.ingestLedger([
    entry('t1', { merchantId: 'm1' }), entry('t2', { merchantId: 'm1' }),
  ]);
  engine.reconcile({});
  engine.schedulePending();
  const running = [...engine.tasks.values()].filter((t) => t.status === 'running');
  const pending = [...engine.tasks.values()].filter((t) => t.status === 'pending');
  assert.equal(running.length, 1);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].error, CODES.NO_SLOT);
});
