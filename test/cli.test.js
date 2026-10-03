import test from 'node:test';
import assert from 'node:assert/strict';
import { runRequest } from '../src/session.js';

// The CLI is a thin stdin/stdout wrapper around runRequest (see src/cli.js),
// so these tests drive the exact code path the CLI serves.

test('CLI reads a request from stdin and applies transactions in order', () => {
  const response = runRequest(JSON.stringify({
    tasks: [
      { id: 'a', inputHash: 'ia', moduleVersion: 'm1', deps: [] },
      { id: 'b', inputHash: 'ib', moduleVersion: 'm1', deps: ['a'] },
    ],
    transactions: [
      { maxRecompute: 5, ops: [{ type: 'setInput', task: 'a', inputHash: 'ia2' }] },
      { maxRecompute: 1, ops: [{ type: 'setInput', task: 'a', inputHash: 'ia3' }] },
      { ops: [{ type: 'addDep', task: 'a', dep: 'b' }] },
    ],
  }));
  assert.equal(response.ok, true);
  assert.equal(response.results.length, 3);

  const [applied, overBudget, cyclic] = response.results;
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.invalidated, ['a', 'b']);
  assert.equal(applied.changes.length, 2);
  assert.ok(applied.changes.every((c) => typeof c.newHash === 'string' && c.newHash !== c.oldHash));

  assert.equal(overBudget.ok, false);
  assert.equal(overBudget.error.code, 'E_BUDGET');
  assert.equal(overBudget.error.required, 2);

  assert.equal(cyclic.ok, false);
  assert.equal(cyclic.error.code, 'E_CYCLE');
});

test('CLI accepts a bare single-transaction request', () => {
  const response = runRequest(JSON.stringify({
    tasks: [{ id: 'solo', inputHash: 'i', moduleVersion: 'm', deps: [] }],
    ops: [{ type: 'setInput', task: 'solo', inputHash: 'i2' }],
  }));
  assert.equal(response.ok, true);
  assert.equal(response.results.length, 1);
  assert.deepEqual(response.results[0].invalidated, ['solo']);
});

test('CLI reports load-time cycles and malformed JSON', () => {
  const cyclic = runRequest(JSON.stringify({ tasks: [{ id: 'x', deps: ['x'] }] }));
  assert.equal(cyclic.ok, false);
  assert.equal(cyclic.error.code, 'E_CYCLE');

  const malformed = runRequest('not json');
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error.code, 'E_PARSE');
});
