import test from 'node:test';
import assert from 'node:assert/strict';
import { validateHistory, InvalidHistoryError } from '../src/validate.js';

const baseHold = {
  id: 'h', op: 'hold', invoke: 0, respond: 1, clock: 0, version: 1,
  amount: 100, deadline: 10, response: { ok: true, holdId: 'H' },
};

function expectInvalid(history, pattern) {
  assert.throws(() => validateHistory(history), (error) => {
    assert.ok(error instanceof InvalidHistoryError);
    assert.equal(error.code, 'INVALID_HISTORY');
    assert.match(error.message, pattern);
    return true;
  });
}

test('accepts a minimal valid history', () => {
  const ops = validateHistory({ operations: [baseHold] });
  assert.equal(ops.length, 1);
});

test('rejects malformed documents', () => {
  expectInvalid(null, /object/);
  expectInvalid([], /object/);
  expectInvalid({}, /operations/);
  expectInvalid({ operations: [{}] }, /id/);
  expectInvalid({ operations: [{ ...baseHold, op: 'refund' }] }, /unknown op/);
  expectInvalid({ operations: [{ ...baseHold, invoke: 5, respond: 1 }] }, /invoke <= respond/);
  expectInvalid({ operations: [{ ...baseHold, clock: -1 }] }, /clock/);
  expectInvalid({ operations: [{ ...baseHold, version: 1.5 }] }, /version/);
  expectInvalid({ operations: [baseHold, baseHold] }, /duplicate operation id/);
});

test('rejects negative capture amounts', () => {
  const capture = {
    id: 'c', op: 'capture', holdId: 'H', invoke: 2, respond: 3, clock: 1, version: 1,
    amount: -5, response: { ok: true, totalCaptured: 0 },
  };
  expectInvalid({ operations: [baseHold, capture] }, /negative capture/);
});

test('rejects expired requests issued past the hold deadline', () => {
  const capture = {
    id: 'c', op: 'capture', holdId: 'H', invoke: 11, respond: 12, clock: 1, version: 1,
    amount: 5, response: { ok: true, totalCaptured: 5 },
  };
  expectInvalid({ operations: [baseHold, capture] }, /expired request/);
  const cancel = {
    id: 'x', op: 'cancel', holdId: 'H', invoke: 11, respond: 12, clock: 1, version: 1,
    response: { ok: true, released: 100 },
  };
  expectInvalid({ operations: [baseHold, cancel] }, /expired request/);
});

test('rejects histories with more than 12 operations', () => {
  const ops = Array.from({ length: 13 }, (_, i) => ({
    id: `a${i}`, op: 'audit', holdId: 'H', invoke: i, respond: i + 0.5, clock: i, version: 1,
    response: { ok: false, error: 'not_found' },
  }));
  expectInvalid({ operations: ops }, /too many operations/);
});
