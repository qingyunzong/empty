import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/cli.js';

// The CLI is a thin wrapper around run(); the stdin/stdout plumbing is
// exercised manually (see README) since the test sandbox forbids spawning
// child processes.

test('end-to-end session', () => {
  const { results } = run({
    commands: [
      { op: 'add_event', id: 'e1', a: 0, b: 10, f: [0, 1, 0] },
      { op: 'add_event', id: 'e2', a: 5, b: 15, f: [0, 1, 0] },
      { op: 'query', x: 'e1', y: 'e2' },
      { op: 'linearizations' },
      { op: 'correct', id: 'e1', f: ['-20', 1, 0] },
      { op: 'query', x: 'e1', y: 'e2' },
      { op: 'undo' },
      { op: 'query', x: 'e1', y: 'e2' },
      { op: 'add_constraint', before: 'e2', after: 'e1' },
      { op: 'add_constraint', before: 'e1', after: 'e2' },
      { op: 'linearizations' },
    ],
  });
  assert.equal(results.length, 11);
  assert.equal(results[2].relation, 'concurrent');
  assert.equal(results[2].certificate.kind, 'overlap');
  assert.equal(results[3].count, 2);
  assert.equal(results[5].relation, 'before');
  assert.equal(results[7].relation, 'concurrent');
  assert.equal(results[10].ok, false);
  assert.equal(results[10].error, 'E_UNSAT');
});

test('error codes: E_RATIONAL, E_RANGE, unknown op', () => {
  const { results } = run([
    { op: 'add_event', id: 'e1', a: 0, b: 1, f: ['1/0', 0, 0] },
    { op: 'add_event', id: 'e2', a: 9, b: 1, f: [0, 1, 0] },
    { op: 'add_event', id: 'e3', a: 0, b: 1, f: [0, 1, 0] },
    { op: 'bogus' },
  ]);
  assert.equal(results[0].error, 'E_RATIONAL');
  assert.equal(results[1].error, 'E_RANGE');
  assert.equal(results[2].ok, true);
  assert.equal(results[3].ok, false);
});

test('single command object and bare array inputs are accepted', () => {
  assert.equal(run({ op: 'add_event', id: 'e1', a: 0, b: 1, f: [0, 1, 0] }).results[0].ok, true);
  assert.equal(run([{ op: 'undo' }]).results[0].error, 'E_NOOP');
});
