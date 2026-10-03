import test from 'node:test';
import assert from 'node:assert/strict';
import { runBatch, InvalidCommand, replayHashOf } from '../src/ledger.js';

test('post occupies available credit and limit invariant is enforced per step', () => {
  const result = runBatch(
    [
      { op: 'post', id: 'p1', account: 'A', amount: 60 },
      { op: 'post', id: 'p2', account: 'A', amount: 50 },
    ],
    { A: 100 },
  );
  assert.equal(result.ok, false);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].invariant, 'NET_PLUS_FROZEN_WITHIN_LIMIT');
  assert.equal(result.violations[0].index, 1);
  assert.equal(result.finalState.accounts.A.postedNet, 110);
});

test('acceptance 3: cancel restores credit and keeps the audit trail', () => {
  const result = runBatch(
    [
      { op: 'post', id: 'p1', account: 'A', amount: 80 },
      { op: 'freeze', account: 'A', amount: 10 },
      { op: 'cancel', postId: 'p1' },
    ],
    { A: 100 },
  );
  assert.equal(result.ok, true);
  const acc = result.finalState.accounts.A;
  assert.equal(acc.postedNet, 0);
  assert.equal(acc.frozen, 10);
  assert.equal(acc.available, 90);
  assert.deepEqual(
    result.trail.map((e) => e.type),
    ['post', 'freeze', 'correction'],
  );
  const correction = result.trail.find((e) => e.type === 'correction');
  assert.equal(correction.ref, 'p1');
  assert.equal(correction.amount, -80);
  assert.equal(result.finalState.volume, 80);
});

test('correction amount is the exact negation of the original post', () => {
  const result = runBatch(
    [
      { op: 'post', id: 'p1', account: 'A', amount: 42 },
      { op: 'cancel', postId: 'p1' },
    ],
    {},
  );
  assert.equal(result.ok, true);
  const post = result.trail.find((e) => e.type === 'post');
  const correction = result.trail.find((e) => e.type === 'correction');
  assert.equal(correction.amount, -post.amount);
  assert.equal(Math.sign(correction.amount), -Math.sign(post.amount));
});

test('cumulative volume is replayable from the audit trail', () => {
  const commands = [
    { op: 'post', id: 'p1', account: 'A', amount: 10 },
    { op: 'post', id: 'p2', account: 'B', amount: 20 },
    { op: 'cancel', postId: 'p1' },
    { op: 'freeze', account: 'B', amount: 5 },
  ];
  const result = runBatch(commands, {});
  assert.equal(result.ok, true);
  assert.equal(result.finalState.volume, 30);
  assert.equal(result.replayHash, replayHashOf(result.trail));
  const again = runBatch(commands, {});
  assert.equal(again.replayHash, result.replayHash);
});

test('negative amounts are rejected with INVALID_COMMAND', () => {
  assert.throws(() => runBatch([{ op: 'post', id: 'p1', account: 'A', amount: -1 }]), InvalidCommand);
  assert.throws(() => runBatch([{ op: 'freeze', account: 'A', amount: -5 }]), InvalidCommand);
});

test('illegal ids are rejected with INVALID_COMMAND', () => {
  assert.throws(
    () =>
      runBatch([
        { op: 'post', id: 'p1', account: 'A', amount: 1 },
        { op: 'post', id: 'p1', account: 'A', amount: 2 },
      ]),
    /duplicate id/,
  );
  assert.throws(() => runBatch([{ op: 'cancel', postId: 'nope' }]), /unknown id/);
  assert.throws(() => runBatch([{ op: 'post', id: '', account: 'A', amount: 1 }]), InvalidCommand);
});

test('cyclic corrections are rejected with INVALID_COMMAND', () => {
  assert.throws(
    () =>
      runBatch([
        { op: 'post', id: 'p1', account: 'A', amount: 1 },
        { op: 'cancel', postId: 'p1' },
        { op: 'cancel', postId: 'p1' },
      ]),
    /cyclic correction/,
  );
  assert.throws(
    () =>
      runBatch([
        { op: 'post', id: 'p1', account: 'A', amount: 1 },
        { op: 'cancel', postId: 'p1' },
        { op: 'cancel', postId: 'p1#correction' },
      ]),
    /cyclic correction/,
  );
});

test('unknown ops and malformed commands are rejected', () => {
  assert.throws(() => runBatch([{ op: 'noop' }]), InvalidCommand);
  assert.throws(() => runBatch([null]), InvalidCommand);
  assert.throws(() => runBatch([{ op: 'post', id: 'p1', account: 'A', amount: Number.NaN }]), InvalidCommand);
});
