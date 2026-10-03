import assert from 'node:assert/strict';
import test from 'node:test';
import { validateInput, ValidationError } from '../src/model.js';

const baseBatch = {
  id: 'P1',
  line: 'L1',
  start: '2026-01-01T00:00:00Z',
  end: '2026-01-01T04:00:00Z',
  output: 10,
  loss: 2,
  expiry: '2026-06-01',
  candidates: ['M1'],
};
const baseMaterial = { id: 'M1', quantity: 50, expiry: '2026-12-01' };

test('accepts a well-formed instance', () => {
  const { materials, batches } = validateInput({ materials: [baseMaterial], batches: [baseBatch] });
  assert.equal(materials.length, 1);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].status, 'released');
});

test('rejects illegal quantities', () => {
  const cases = [
    { materials: [{ ...baseMaterial, quantity: -1 }], batches: [] },
    { materials: [{ ...baseMaterial, quantity: 1.5 }], batches: [] },
    { materials: [baseMaterial], batches: [{ ...baseBatch, output: 0 }] },
    { materials: [baseMaterial], batches: [{ ...baseBatch, output: 'ten' }] },
    { materials: [baseMaterial], batches: [{ ...baseBatch, loss: -3 }] },
    { materials: [baseMaterial], batches: [{ ...baseBatch, loss: 0.5 }] },
  ];
  for (const input of cases) {
    assert.throws(() => validateInput(input), ValidationError, JSON.stringify(input));
  }
});

test('rejects broken candidate references', () => {
  assert.throws(
    () => validateInput({ materials: [baseMaterial], batches: [{ ...baseBatch, candidates: ['M9'] }] }),
    /broken reference/,
  );
});

test('rejects duplicate ids, self references and cycles', () => {
  assert.throws(
    () => validateInput({ materials: [baseMaterial, { ...baseMaterial }], batches: [] }),
    /duplicate id/,
  );
  assert.throws(
    () => validateInput({ materials: [baseMaterial], batches: [{ ...baseBatch, candidates: ['P1'] }] }),
    /own candidate/,
  );
  const p2 = { ...baseBatch, id: 'P2', candidates: ['P1'] };
  assert.throws(
    () => validateInput({ materials: [], batches: [{ ...baseBatch, candidates: ['P2'] }, p2] }),
    /cycle detected/,
  );
});

test('rejects malformed dates and intervals', () => {
  assert.throws(
    () => validateInput({ materials: [{ ...baseMaterial, expiry: 'not-a-date' }], batches: [] }),
    ValidationError,
  );
  assert.throws(
    () =>
      validateInput({
        materials: [baseMaterial],
        batches: [{ ...baseBatch, start: '2026-01-02T00:00:00Z', end: '2026-01-01T00:00:00Z' }],
      }),
    /end must not be before start/,
  );
});
