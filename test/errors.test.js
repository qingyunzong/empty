import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, ERR } from '../src/index.js';

test('ERR_SCHEMA: malformed events and params', () => {
  assert.equal(analyze({ events: 'nope' }).error.code, ERR.SCHEMA);
  assert.equal(analyze({ events: [{ type: 'run', start: 0, end: 1 }] }).error.code, ERR.SCHEMA); // missing id
  assert.equal(analyze({ events: [{ id: 1, type: 'spin', start: 0, end: 1 }] }).error.code, ERR.SCHEMA); // bad type
  assert.equal(analyze({ events: [{ id: 1, type: 'run', start: 5, end: 1 }] }).error.code, ERR.SCHEMA); // end<start
  assert.equal(analyze({ events: [], params: { maxSkewMs: -1 } }).error.code, ERR.SCHEMA);
  assert.equal(analyze({ events: [], params: { quality: 2 } }).error.code, ERR.SCHEMA);
  assert.equal(analyze(null).error.code, ERR.SCHEMA);
});

test('ERR_CONFLICT: same id with conflicting payload', () => {
  const r = analyze({
    events: [
      { id: 'x', type: 'run', start: 0, end: 10 },
      { id: 'x', type: 'fault', start: 0, end: 10 },
    ],
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, ERR.CONFLICT);
});

test('exact duplicates (same id, same payload) are deduped, not an error', () => {
  const r = analyze({
    events: [
      { id: 'x', type: 'fault', start: 0, end: 10 },
      { id: 'x', type: 'fault', start: 0, end: 10 },
      { id: 'y', type: 'run', start: 10, end: 20 },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.oee.attribution.fault, 10); // counted once
});
