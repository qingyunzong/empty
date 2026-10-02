import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBatch, ValidationError, isValidTimeString } from '../src/validate.js';

const good = {
  id: 'e1',
  equipment: 'eq',
  valid_time: '2024-01-01T00:00:00Z',
  state: 'up',
  tx_id: 'tx1',
  tx_time: '2024-01-01T01:00:00Z',
};

test('accepts a well-formed batch and normalizes it', () => {
  const batch = validateBatch({ tx_id: 'tx1', tx_time: good.tx_time, events: [good] });
  assert.equal(batch.tx_id, 'tx1');
  assert.equal(batch.events.length, 1);
  assert.deepEqual(Object.keys(batch.events[0]), [
    'id',
    'equipment',
    'valid_time',
    'state',
    'tx_id',
    'tx_time',
  ]);
});

test('accepts a bare event array with uniform tx_id/tx_time', () => {
  const batch = validateBatch([good, { ...good, id: 'e2' }]);
  assert.equal(batch.tx_id, 'tx1');
  assert.equal(batch.tx_time, good.tx_time);
});

test('time validation rejects malformed and impossible timestamps', () => {
  assert.equal(isValidTimeString('2024-01-01'), true);
  assert.equal(isValidTimeString('2024-01-01T10:20:30Z'), true);
  assert.equal(isValidTimeString('2024-01-01T10:20:30+08:00'), true);
  assert.equal(isValidTimeString('2024-02-30T00:00:00Z'), false); // impossible day
  assert.equal(isValidTimeString('2024-13-01T00:00:00Z'), false); // month 13
  assert.equal(isValidTimeString('not-a-time'), false);
  assert.equal(isValidTimeString('2024-01-01T10:20:30'), false); // no zone
  assert.equal(isValidTimeString(1704067200000), false); // not a string
});

test('collects every problem in an invalid batch', () => {
  const bad = {
    tx_id: 'tx2',
    tx_time: '2024-01-02T00:00:00Z',
    events: [
      { ...good, id: 'ok', tx_id: 'tx2', tx_time: '2024-01-02T00:00:00Z' },
      { ...good, id: 'bad-state', state: 'broken', tx_id: 'tx2', tx_time: '2024-01-02T00:00:00Z' },
      { ...good, id: 'bad-time', valid_time: '2024-02-30T09:00:00Z', tx_id: 'tx2', tx_time: '2024-01-02T00:00:00Z' },
      { ...good, id: 'extra', extra: 1, tx_id: 'tx2', tx_time: '2024-01-02T00:00:00Z' },
    ],
  };
  let error;
  try {
    validateBatch(bad);
  } catch (err) {
    error = err;
  }
  assert.ok(error instanceof ValidationError);
  assert.ok(error.problems.some((p) => p.includes('events[1].state')));
  assert.ok(error.problems.some((p) => p.includes('events[2].valid_time')));
  assert.ok(error.problems.some((p) => p.includes('events[3].extra')));
});

test('rejects mismatched tx_id between envelope and events', () => {
  assert.throws(
    () => validateBatch({ tx_id: 'tx1', tx_time: good.tx_time, events: [{ ...good, tx_id: 'other' }] }),
    ValidationError,
  );
});

test('rejects empty batches and missing fields', () => {
  assert.throws(() => validateBatch({ tx_id: 'tx1', tx_time: good.tx_time, events: [] }), ValidationError);
  assert.throws(() => validateBatch([{ ...good, equipment: '' }]), ValidationError);
  assert.throws(() => validateBatch('nonsense'), ValidationError);
});
