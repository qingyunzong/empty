import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linearize, findWitness, findMinimalConflict } from '../src/linearize.js';
import { validateHistory, InvalidHistoryError } from '../src/validate.js';

const hold = (over = {}) => ({
  id: 'h1', op: 'hold', holdId: 'H1', amount: 100, deadline: 50,
  invoke: 0, respond: 2, clock: 1, version: 1, ...over,
});
const capture = (over = {}) => ({
  id: 'c1', op: 'capture', holdId: 'H1', amount: 40, captured: 40,
  invoke: 3, respond: 8, clock: 2, version: 1, ...over,
});
const cancel = (over = {}) => ({
  id: 'x1', op: 'cancel', holdId: 'H1',
  invoke: 9, respond: 11, clock: 3, version: 1, ...over,
});
const audit = (result, over = {}) => ({
  id: 'a1', op: 'audit', holdId: 'H1', result,
  invoke: 12, respond: 13, clock: 4, version: 1, ...over,
});

test('acceptance 1: overlapping audit may read any legal intermediate state', () => {
  // Audit overlaps the capture window [3,8]; both the pre-capture and
  // post-capture readings are legal intermediate states.
  const before = linearize({ operations: [hold(), capture(), audit({ frozen: 100, captured: 0, available: 100 }, { invoke: 4, respond: 6 })] });
  assert.equal(before.status, 'LINEARIZABLE');

  const after = linearize({ operations: [hold(), capture(), audit({ frozen: 60, captured: 40, available: 60 }, { invoke: 4, respond: 6 })] });
  assert.equal(after.status, 'LINEARIZABLE');

  // An impossible intermediate state (frozen+captured != held amount) is rejected.
  const bogus = linearize({ operations: [hold(), capture(), audit({ frozen: 50, captured: 40, available: 50 }, { invoke: 4, respond: 6 })] });
  assert.equal(bogus.status, 'NOT_LINEARIZABLE');
});

test('acceptance 2: capture after a completed cancel is not linearizable', () => {
  const history = { operations: [hold(), cancel({ invoke: 3, respond: 5 }), capture({ invoke: 6, respond: 8, amount: 10, captured: 10 })] };
  const result = linearize(history);
  assert.equal(result.status, 'NOT_LINEARIZABLE');
  assert.deepEqual([...result.conflict].sort(), ['c1', 'h1', 'x1']);
});

test('acceptance 2b: overlapping capture/cancel may be ordered either way', () => {
  // Capture [3,5] overlaps cancel [4,6]: capture-first is a valid witness.
  const history = { operations: [hold(), capture({ invoke: 3, respond: 5, amount: 10, captured: 10 }), cancel({ invoke: 4, respond: 6 })] };
  assert.equal(linearize(history).status, 'LINEARIZABLE');
});

test('acceptance 3: partial capture then cancel releases only the remainder', () => {
  const history = {
    operations: [
      hold(),
      capture({ amount: 30, captured: 30, invoke: 3, respond: 5 }),
      cancel({ invoke: 6, respond: 8 }),
      audit({ frozen: 0, captured: 30, available: 0 }, { invoke: 9, respond: 10 }),
    ],
  };
  const result = linearize(history);
  assert.equal(result.status, 'LINEARIZABLE');
  assert.deepEqual(result.audits, [{ id: 'a1', holdId: 'H1', frozen: 0, captured: 30, available: 0 }]);
  const cap = result.witness.find((w) => w.id === 'c1');
  assert.equal(cap.allocated, 30);

  // Claiming the cancel released nothing (frozen stays 70) must fail.
  const wrong = linearize({
    operations: [
      hold(),
      capture({ amount: 30, captured: 30, invoke: 3, respond: 5 }),
      cancel({ invoke: 6, respond: 8 }),
      audit({ frozen: 70, captured: 30, available: 70 }, { invoke: 9, respond: 10 }),
    ],
  });
  assert.equal(wrong.status, 'NOT_LINEARIZABLE');
});

test('multiple captures accumulate but never exceed the held amount', () => {
  const ok = linearize({
    operations: [
      hold(),
      capture({ id: 'c1', amount: 40, captured: 40, invoke: 3, respond: 4 }),
      capture({ id: 'c2', amount: 40, captured: 80, invoke: 5, respond: 6 }),
      capture({ id: 'c3', amount: 40, captured: 100, invoke: 7, respond: 8 }),
      audit({ frozen: 0, captured: 100, available: 0 }, { invoke: 9, respond: 10 }),
    ],
  });
  assert.equal(ok.status, 'LINEARIZABLE');

  const over = linearize({
    operations: [
      hold(),
      capture({ id: 'c1', amount: 60, captured: 60, invoke: 3, respond: 4 }),
      capture({ id: 'c2', amount: 60, captured: 120, invoke: 5, respond: 6 }),
    ],
  });
  assert.equal(over.status, 'NOT_LINEARIZABLE');
});

test('witness linearization points lie inside [invoke, respond] and respect real time', () => {
  const history = {
    operations: [
      hold(),
      capture({ amount: 25, captured: 25, invoke: 3, respond: 5 }),
      audit({ frozen: 75, captured: 25, available: 75 }, { invoke: 4, respond: 6 }),
      cancel({ invoke: 7, respond: 8 }),
    ],
  };
  const found = findWitness(history);
  assert.ok(found);
  const byId = new Map(history.operations.map((o) => [o.id, o]));
  let prev = -Infinity;
  for (const entry of found.witness) {
    const op = byId.get(entry.id);
    assert.ok(entry.linearizationPoint >= op.invoke, `${entry.id} lp >= invoke`);
    assert.ok(entry.linearizationPoint <= op.respond, `${entry.id} lp <= respond`);
    assert.ok(entry.linearizationPoint >= prev, 'lp monotone along witness');
    prev = entry.linearizationPoint;
  }
});

test('INVALID_HISTORY: malformed shape, negative capture, expired request', () => {
  assert.throws(() => validateHistory({}), InvalidHistoryError);
  assert.throws(() => validateHistory({ operations: [{ op: 'hold' }] }), InvalidHistoryError);
  assert.throws(
    () => validateHistory({ operations: [hold(), capture({ amount: -1, captured: 0 })] }),
    /negative capture/,
  );
  assert.throws(
    () => validateHistory({ operations: [hold({ deadline: 10 }), capture({ invoke: 11, respond: 12 })] }),
    /expired request/,
  );
  assert.throws(
    () => validateHistory({ operations: [hold(), capture({ holdId: 'NOPE' })] }),
    /unknown holdId/,
  );
});

test('minimal conflict set is reported for non-linearizable histories', () => {
  const conflict = findMinimalConflict({
    operations: [hold(), cancel({ invoke: 3, respond: 5 }), capture({ invoke: 6, respond: 8, amount: 10, captured: 10 })],
  });
  assert.deepEqual([...conflict].sort(), ['c1', 'h1', 'x1']);
});
