import test from 'node:test';
import assert from 'node:assert/strict';
import { Model, InvalidModelError } from '../src/model.js';

const accounts = [{ id: 'A0', limit: 5 }];

function pool(tasks) {
  return new Model(accounts, tasks);
}

test('unknown task is rejected with INVALID_MODEL', () => {
  const m = pool([{ id: 'T0', kind: 'freeze', account: 0, amount: 2 }]);
  assert.throws(() => m.apply('T9', 'R'), (err) => {
    assert.ok(err instanceof InvalidModelError);
    assert.equal(err.code, 'INVALID_MODEL');
    assert.match(err.message, /unknown task/);
    return true;
  });
});

test('duplicate complete is rejected with INVALID_MODEL', () => {
  const m = pool([{ id: 'T0', kind: 'debit', account: 0, amount: 2 }]);
  m.apply('T0', 'R');
  m.apply('T0', 'C');
  assert.throws(() => m.apply('T0', 'C'), /INVALID_MODEL: duplicate complete/);
});

test('out-of-order steps are rejected with INVALID_MODEL', () => {
  const m = pool([{ id: 'T0', kind: 'freeze', account: 0, amount: 2 }]);
  assert.throws(() => m.apply('T0', 'C'), /INVALID_MODEL/);
  m.apply('T0', 'R');
  assert.throws(() => m.apply('T0', 'R'), /INVALID_MODEL/);
});

test('over-limit input is rejected with INVALID_MODEL at construction', () => {
  assert.throws(
    () => pool([{ id: 'T0', kind: 'freeze', account: 0, amount: 6 }]),
    /INVALID_MODEL: .*exceeds limit/,
  );
});

test('over-limit reserve is rejected with INVALID_MODEL at runtime', () => {
  const m = pool([
    { id: 'T0', kind: 'freeze', account: 0, amount: 4 },
    { id: 'T1', kind: 'debit', account: 0, amount: 2 },
  ]);
  m.apply('T0', 'R');
  assert.throws(() => m.apply('T1', 'R'), /INVALID_MODEL: .*exceeds limit/);
  assert.equal(m.frozen[0], 4);
});

test('debit reserve holds quota and complete converts it to used', () => {
  const m = pool([{ id: 'T0', kind: 'debit', account: 0, amount: 3 }]);
  m.apply('T0', 'R');
  assert.deepEqual([m.used[0], m.frozen[0]], [0, 3]);
  m.apply('T0', 'C');
  assert.deepEqual([m.used[0], m.frozen[0]], [3, 0]);
});

test('unfreeze cancels only an incomplete freeze', () => {
  const tasks = [
    { id: 'T0', kind: 'freeze', account: 0, amount: 3 },
    { id: 'T1', kind: 'unfreeze', account: 0, amount: 3, target: 'T0' },
  ];
  const pending = pool(tasks);
  assert.throws(() => pending.apply('T1', 'R'), /INVALID_MODEL/);

  const settled = pool(tasks);
  settled.apply('T0', 'R');
  settled.apply('T0', 'C');
  assert.throws(() => settled.apply('T1', 'R'), /INVALID_MODEL/);

  const ok = pool(tasks);
  ok.apply('T0', 'R');
  ok.apply('T1', 'R');
  assert.equal(ok.frozen[0], 0);
  assert.throws(() => ok.apply('T0', 'C'), /INVALID_MODEL/);
  ok.apply('T1', 'C');
  assert.ok(ok.invariantHolds());
});

test('cancelDebit restores the hold only before complete', () => {
  const tasks = [
    { id: 'T0', kind: 'debit', account: 0, amount: 2 },
    { id: 'T1', kind: 'cancelDebit', account: 0, amount: 2, target: 'T0' },
  ];
  const ok = pool(tasks);
  ok.apply('T0', 'R');
  ok.apply('T1', 'R');
  assert.deepEqual([ok.used[0], ok.frozen[0]], [0, 0]);

  const settled = pool(tasks);
  settled.apply('T0', 'R');
  settled.apply('T0', 'C');
  assert.throws(() => settled.apply('T1', 'R'), /INVALID_MODEL/);
});

test('freeze and debit share the same limit budget', () => {
  const m = pool([
    { id: 'T0', kind: 'freeze', account: 0, amount: 3 },
    { id: 'T1', kind: 'debit', account: 0, amount: 3 },
    { id: 'T2', kind: 'debit', account: 0, amount: 2 },
  ]);
  m.apply('T0', 'R');
  assert.throws(() => m.apply('T1', 'R'), /INVALID_MODEL/);
  m.apply('T0', 'C');
  m.apply('T2', 'R');
  assert.equal(m.used[0] + m.frozen[0], 5);
});
