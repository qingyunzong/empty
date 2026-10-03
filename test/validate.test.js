'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateInput, ValidationError } = require('../lib/validate');

const validStage = { id: 's1', type: 'trade', account: 'A', amount: 10 };
const base = () => ({
  transactions: [{ id: 'tx1', stages: [validStage] }],
  batches: [{ id: 'b1', domains: ['trade'], quotas: { A: 100 } }],
  requests: [{ idempotencyKey: 'k1', transactionId: 'tx1' }],
});

function expectInvalid(input, pattern) {
  assert.throws(() => validateInput(input), (err) => {
    assert.ok(err instanceof ValidationError);
    assert.match(err.message, pattern);
    return true;
  });
}

test('valid input normalizes defaults', () => {
  const data = validateInput(base());
  const stage = data.transactions.get('tx1').stageById.get('s1');
  assert.equal(stage.status, 'completed');
  assert.deepEqual(stage.dependsOn, []);
});

test('rejects malformed structures', () => {
  expectInvalid(null, /object/);
  expectInvalid({}, /transactions/);
  expectInvalid({ ...base(), transactions: [{}] }, /id/);
  expectInvalid(
    { ...base(), transactions: [{ id: 'tx1', stages: [{ ...validStage, type: 'x' }] }] },
    /type/
  );
  expectInvalid(
    { ...base(), transactions: [{ id: 'tx1', stages: [{ ...validStage, amount: -1 }] }] },
    /amount/
  );
  expectInvalid(
    { ...base(), transactions: [{ id: 'tx1', stages: [{ ...validStage, status: 'void' }] }] },
    /status/
  );
  expectInvalid(
    { ...base(), transactions: [{ id: 'tx1', stages: [{ ...validStage, dependsOn: ['ghost'] }] }] },
    /unknown stage/
  );
  expectInvalid(
    {
      ...base(),
      transactions: [
        {
          id: 'tx1',
          stages: [
            { ...validStage, dependsOn: ['s2'] },
            { ...validStage, id: 's2', dependsOn: ['s1'] },
          ],
        },
      ],
    },
    /cyclic/
  );
  expectInvalid(
    { ...base(), batches: [{ id: 'b1', domains: ['nope'], quotas: {} }] },
    /domains/
  );
  expectInvalid(
    { ...base(), batches: [{ id: 'b1', domains: ['trade'], quotas: { A: -5 } }] },
    /quotas/
  );
  expectInvalid(
    { ...base(), requests: [{ idempotencyKey: '', transactionId: 'tx1' }] },
    /idempotencyKey/
  );
  expectInvalid(
    { ...base(), transactions: [{ id: 'tx1', stages: [validStage] }, { id: 'tx1', stages: [validStage] }] },
    /duplicate transaction/
  );
});
