import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateHistory, InvalidHistory } from '../src/validate.js';

const fixture = (name) =>
  readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').then(JSON.parse);

test('accepts a well-formed history and normalizes optional fields', () => {
  const ops = validateHistory([
    {
      client: 'c1',
      opId: 'a',
      invocationTime: 0,
      responseTime: 1,
      type: 'cancel',
      account: 'alice',
      reserveId: 'r1',
      ok: false,
    },
  ]);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].amount, null);
  assert.equal(ops[0].result, null);
});

test('rejects non-array histories', () => {
  assert.throws(() => validateHistory({}), (e) => e instanceof InvalidHistory && e.code === 'INVALID_HISTORY');
  assert.throws(() => validateHistory('nope'), InvalidHistory);
});

test('rejects inverted time intervals', async () => {
  const data = await fixture('invalid-time-inversion.json');
  assert.throws(() => validateHistory(data), /inverted interval/);
});

test('rejects negative amounts', async () => {
  const data = await fixture('invalid-negative-amount.json');
  assert.throws(() => validateHistory(data), /negative amount/);
});

test('rejects duplicate opIds (duplicate responses)', async () => {
  const data = await fixture('duplicate-opid.json');
  assert.throws(() => validateHistory(data), /duplicate opId "res1"/);
});

test('zero amount is legal and well-defined', async () => {
  const data = await fixture('zero-amount.json');
  const ops = validateHistory(data);
  assert.equal(ops[0].amount, 0);
});

test('rejects missing fields and bad types', () => {
  const base = {
    client: 'c1',
    opId: 'a',
    invocationTime: 0,
    responseTime: 1,
    type: 'reserve',
    account: 'alice',
    amount: 1,
    reserveId: 'r1',
    ok: true,
  };
  for (const key of Object.keys(base)) {
    const bad = { ...base };
    delete bad[key];
    assert.throws(() => validateHistory([bad]), InvalidHistory, `missing ${key}`);
  }
  assert.throws(
    () => validateHistory([{ ...base, ok: 'yes' }]),
    InvalidHistory
  );
});

test('read requires a result object with non-negative numbers', () => {
  const read = {
    client: 'c1',
    opId: 'r',
    invocationTime: 0,
    responseTime: 1,
    type: 'read',
    account: 'alice',
    ok: true,
  };
  assert.throws(() => validateHistory([read]), /"result" must be an object/);
  assert.throws(
    () => validateHistory([{ ...read, result: { balance: -1, frozen: 0 } }]),
    /must be >= 0/
  );
  assert.throws(
    () => validateHistory([{ ...read, reserveId: 'x', result: { balance: 0, frozen: 0 } }]),
    /reserveId.*read/
  );
});
