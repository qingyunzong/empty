import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyze.js';

const expectCode = (code) => (err) => err && err.code === code;

test('rejects non-array input with ERR_SCHEMA', () => {
  assert.throws(() => analyze({}), expectCode('ERR_SCHEMA'));
});

test('rejects event with missing id', () => {
  assert.throws(() => analyze([{ type: 'run', start: 0, end: 1 }]), expectCode('ERR_SCHEMA'));
});

test('rejects unknown event type', () => {
  assert.throws(
    () => analyze([{ id: 'a', type: 'breakdown', start: 0, end: 1 }]),
    expectCode('ERR_SCHEMA'),
  );
});

test('rejects end <= start', () => {
  assert.throws(() => analyze([{ id: 'a', type: 'run', start: 10, end: 10 }]), expectCode('ERR_SCHEMA'));
  assert.throws(() => analyze([{ id: 'a', type: 'run', start: 10, end: 5 }]), expectCode('ERR_SCHEMA'));
});

test('rejects non-integer timestamps', () => {
  assert.throws(
    () => analyze([{ id: 'a', type: 'run', start: 0.5, end: 1 }]),
    expectCode('ERR_SCHEMA'),
  );
});

test('rejects invalid params with ERR_SCHEMA', () => {
  assert.throws(() => analyze([], { maxSkewMs: -1 }), expectCode('ERR_SCHEMA'));
  assert.throws(() => analyze([], { uncovered: 'maybe' }), expectCode('ERR_SCHEMA'));
});

test('conflicting duplicate id raises ERR_CONFLICT', () => {
  assert.throws(
    () =>
      analyze([
        { id: 'a', type: 'run', start: 0, end: 10 },
        { id: 'a', type: 'fault', start: 0, end: 10 },
      ]),
    expectCode('ERR_CONFLICT'),
  );
});

test('identical duplicate id is deduplicated silently', () => {
  const cert = analyze([
    { id: 'a', type: 'fault', start: 0, end: 10 },
    { id: 'a', type: 'fault', start: 0, end: 10 },
  ]);
  assert.equal(cert.input.eventCount, 1);
  assert.equal(cert.oee.unplannedDowntimeMs, 10);
});
