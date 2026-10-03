'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Engine, JournalStore } = require('../src/engine');

const DAY = '2026-10-04';
const entry = (id, over = {}) => ({
  id, accountId: 'a1', day: DAY, amount: 100, currency: 'CNY', status: 'settled', ...over,
});

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eod-store-'));
}

function engineIn(dir) {
  const store = new JournalStore(dir);
  const engine = new Engine({ slots: 2, store });
  engine.loadSnapshot([entry('t1', { amount: 90 })]);
  engine.ingestLedger([entry('t1')]);
  engine.reconcile({});
  return engine;
}

test('committed plan is replayed on recovery with identical effect', () => {
  const dir = tmpdir();
  const engine = engineIn(dir);
  engine.applyTask('task-1');
  const bytesAfterApply = engine.snapshotBytes();

  const recovered = Engine.recover({ store: new JournalStore(dir) });
  assert.deepEqual(recovered.report().repaired, ['task-1']);
  assert.equal(recovered.snapshotBytes(), bytesAfterApply);
});

test('failure point 1: plan without commit is discarded on recovery', () => {
  const dir = tmpdir();
  const engine = engineIn(dir);
  engine.applyTask('task-1');
  // simulate a crash: a second plan written, process died before commit
  const store = new JournalStore(dir);
  store.writePlan({ planId: 'plan-task-2', taskId: 'task-2', event: { lamport: 9, source: 'engine', seq: 9, accountId: 'a1', day: DAY, taskId: 'task-2' }, before: '[]', after: '[]' });

  const recovered = Engine.recover({ store: new JournalStore(dir) });
  assert.deepEqual(recovered.report().repaired, ['task-1']); // task-2 discarded
});

test('failure point 2: replay after commit is idempotent', () => {
  const dir = tmpdir();
  const engine = engineIn(dir);
  engine.applyTask('task-1');
  const bytes = engine.snapshotBytes();

  const store = new JournalStore(dir);
  // duplicate commit lines (e.g. retried write before crash) must not double-apply
  store.writeCommit('plan-task-1');
  const recovered = Engine.recover({ store: new JournalStore(dir) });
  assert.deepEqual(recovered.report().repaired, ['task-1']);
  assert.equal(recovered.snapshotBytes(), bytes);

  // recovering twice from the same journal yields the same state
  const again = Engine.recover({ store: new JournalStore(dir) });
  assert.equal(again.snapshotBytes(), bytes);
  assert.deepEqual(again.report().repaired, ['task-1']);
});

test('torn tail write (partial last line) is ignored', () => {
  const dir = tmpdir();
  const engine = engineIn(dir);
  engine.applyTask('task-1');
  fs.appendFileSync(path.join(dir, 'journal.log'), '{"op":"plan","planId":"plan-tas');
  const recovered = Engine.recover({ store: new JournalStore(dir) });
  assert.deepEqual(recovered.report().repaired, ['task-1']);
});

test('undo after recovery restores byte-exact snapshot', () => {
  const dir = tmpdir();
  const engine = engineIn(dir);
  const originalBytes = engine.snapshotBytes();
  engine.applyTask('task-1');

  const recovered = Engine.recover({ store: new JournalStore(dir) });
  recovered.undo('task-1');
  assert.equal(recovered.snapshotBytes(), originalBytes);
});
