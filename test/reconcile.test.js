import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcile,
  validateInput,
  isBalanced,
  totalImpact,
  InvalidReconError,
} from '../src/reconcile.js';

const normal = (entryId, account, amount) => ({ entryId, account, amount, type: 'normal' });
const reversal = (entryId, account, amount, reversalOf) => ({
  entryId,
  account,
  amount,
  type: 'reversal',
  reversalOf,
});

test('full match is balanced', () => {
  const expected = [normal('e1', 'cash', 100), normal('e2', 'ar', 50)];
  const actual = [normal('e2', 'ar', 50), normal('e1', 'cash', 100)];
  const diffs = reconcile(expected, actual);
  assert.ok(isBalanced(diffs));
  assert.equal(totalImpact(diffs), 0);
});

test('missing entry is reported', () => {
  const diffs = reconcile([normal('e1', 'cash', 100)], []);
  assert.deepEqual(diffs.missing.map((e) => e.entryId), ['e1']);
  assert.equal(totalImpact(diffs), -100);
});

test('extra entry is reported', () => {
  const diffs = reconcile([], [normal('a1', 'cash', 70)]);
  assert.deepEqual(diffs.extra.map((e) => e.entryId), ['a1']);
  assert.equal(totalImpact(diffs), 70);
});

test('amount mismatch pairs same id and account', () => {
  const diffs = reconcile([normal('e1', 'cash', 100)], [normal('e1', 'cash', 130)]);
  assert.equal(diffs.amountMismatch.length, 1);
  assert.equal(diffs.amountMismatch[0].expected.amount, 100);
  assert.equal(diffs.amountMismatch[0].actual.amount, 130);
  assert.equal(totalImpact(diffs), 30);
});

test('valid reversal pair cancels within a side', () => {
  const expected = [normal('e1', 'cash', 100), reversal('r1', 'cash', -100, 'e1')];
  const diffs = reconcile(expected, []);
  assert.ok(isBalanced(diffs));
});

test('orphan reversal is flagged as invalid reversal', () => {
  const diffs = reconcile([], [reversal('r1', 'cash', -100, 'e1')]);
  assert.equal(diffs.invalidReversal.length, 1);
  assert.equal(diffs.invalidReversal[0].entry.entryId, 'r1');
  assert.match(diffs.invalidReversal[0].reason, /not found/);
  assert.equal(totalImpact(diffs), -100);
});

test('unmatched original is not offset by its reversal alone', () => {
  // actual holds the original plus a valid reversal -> they cancel per-side,
  // so the expected original stays missing instead of being netted away.
  const expected = [normal('e1', 'cash', 100)];
  const actual = [normal('e1', 'cash', 100), reversal('r1', 'cash', -100, 'e1')];
  const diffs = reconcile(expected, actual);
  assert.deepEqual(diffs.missing.map((e) => e.entryId), ['e1']);
  assert.equal(diffs.invalidReversal.length, 0);
  assert.equal(totalImpact(diffs), -100);
});

test('reversal with wrong magnitude is an invalid reversal, original stays in pool', () => {
  const diffs = reconcile(
    [normal('e1', 'cash', 100), reversal('r1', 'cash', -60, 'e1')],
    [normal('e1', 'cash', 100)],
  );
  assert.equal(diffs.invalidReversal.length, 1);
  assert.match(diffs.invalidReversal[0].reason, /not the opposite/);
  assert.ok(isBalanced({ ...diffs, invalidReversal: [] }));
});

test('duplicate entryId within a side is rejected', () => {
  assert.throws(
    () => validateInput({ expected: [normal('e1', 'cash', 1), normal('e1', 'cash', 2)], actual: [] }),
    (err) => err instanceof InvalidReconError && err.code === 'INVALID_RECON' && /duplicate/.test(err.message),
  );
});

test('negative amount on a normal entry is rejected', () => {
  assert.throws(
    () => validateInput({ expected: [normal('e1', 'cash', -5)], actual: [] }),
    (err) => err.code === 'INVALID_RECON' && /negative amount/.test(err.message),
  );
});

test('reversal chain is rejected', () => {
  const input = {
    expected: [
      normal('e1', 'cash', 100),
      reversal('r1', 'cash', -100, 'e1'),
      reversal('r2', 'cash', 100, 'r1'),
    ],
    actual: [],
  };
  assert.throws(
    () => validateInput(input),
    (err) => err.code === 'INVALID_RECON' && /reversal chain/.test(err.message),
  );
});

test('self-referencing reversal is rejected as a chain', () => {
  assert.throws(
    () => validateInput({ expected: [reversal('r1', 'cash', -1, 'r1')], actual: [] }),
    (err) => err.code === 'INVALID_RECON' && /reversal chain/.test(err.message),
  );
});

test('same id on both sides is not a duplicate', () => {
  const input = { expected: [normal('e1', 'cash', 1)], actual: [normal('e1', 'cash', 1)] };
  assert.doesNotThrow(() => validateInput(input));
});
