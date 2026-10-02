import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent, ValidationError } from '../src/event.js';
import { compareVC } from '../src/vclock.js';

test('validateEvent accepts a well-formed event', () => {
  const ev = validateEvent({ id: 'e1', device: 'A', ts: 3, vc: { A: 1 }, type: 'RUN' });
  assert.deepEqual(ev, { id: 'e1', device: 'A', ts: 3, vc: { A: 1 }, type: 'RUN' });
});

test('validateEvent rejects illegal vector clocks', () => {
  const base = { id: 'e1', device: 'A', ts: 0, type: 'RUN' };
  for (const vc of [[1], null, 'x', { A: -1 }, { A: 1.5 }, { A: '1' }, { '': 1 }]) {
    assert.throws(() => validateEvent({ ...base, vc }), ValidationError, `vc=${JSON.stringify(vc)}`);
  }
});

test('validateEvent rejects malformed fields', () => {
  assert.throws(() => validateEvent(null), ValidationError);
  assert.throws(() => validateEvent({ device: 'A', ts: 0, vc: {}, type: 'RUN' }), ValidationError);
  assert.throws(() => validateEvent({ id: 'e', device: 'A', ts: NaN, vc: {}, type: 'RUN' }), ValidationError);
  assert.throws(() => validateEvent({ id: 'e', device: 'A', ts: 0, vc: {}, type: '' }), ValidationError);
});

test('compareVC orders and detects concurrency', () => {
  assert.equal(compareVC({ A: 1 }, { A: 2 }), 'lt');
  assert.equal(compareVC({ A: 2 }, { A: 1 }), 'gt');
  assert.equal(compareVC({ A: 1 }, { A: 1 }), 'eq');
  assert.equal(compareVC({ A: 1 }, { B: 1 }), 'concurrent');
  assert.equal(compareVC({ A: 1, B: 1 }, { A: 1, B: 2 }), 'lt');
  assert.equal(compareVC({ A: 2, B: 1 }, { A: 1, B: 2 }), 'concurrent');
});
