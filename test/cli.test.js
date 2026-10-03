import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCommands } from '../src/cli-core.js';

function runCli(input) {
  return runCommands(input);
}

test('CLI processes a JSON array of commands from stdin', () => {
  const out = runCli(JSON.stringify([
    { op: 'import', tasks: [
      { id: 'a', priority: '3/2', cost: ['1/2', '1'], duration: ['0', '1/4'] },
      { id: 'b', priority: '1', cost: ['0', '1'], duration: ['0', '1/4'], requires: ['a'] },
    ] },
    { op: 'solve', budget: '1', durationLimit: '1/2' },
    { op: 'undo' },
    { op: 'state' },
  ]));
  assert.equal(out.length, 4);
  assert.deepEqual(out[0], { ok: true, imported: ['a', 'b'] });
  assert.equal(out[1].ok, true);
  assert.deepEqual(out[1].selected, ['a']);
  assert.deepEqual(out[1].costInterval, ['1/2', '1']);
  assert.deepEqual(out[1].durationInterval, ['0', '1/4']);
  assert.equal(out[1].prioritySum, '3/2');
  assert.equal(out[1].reasons.b.code, 'budget');
  assert.equal(out[1].certificate.selected.join(','), 'a');
  assert.deepEqual(out[2], { ok: true, undone: ['a', 'b'] });
  assert.equal(out[3].ok, true);
  assert.deepEqual(out[3].tasks, []);
});

test('CLI accepts NDJSON (one command per line)', () => {
  const out = runCli([
    JSON.stringify({ op: 'import', tasks: [{ id: 'x', priority: 2, cost: [0, 1], duration: [0, 1] }] }),
    JSON.stringify({ op: 'solve', budget: '1', durationLimit: '1' }),
  ].join('\n'));
  assert.equal(out[0].ok, true);
  assert.deepEqual(out[1].selected, ['x']);
});

test('CLI reports E_RATIONAL for invalid fractions', () => {
  const out = runCli(JSON.stringify([
    { op: 'import', tasks: [{ id: 'x', priority: 'not-a-number', cost: ['0', '1'], duration: ['0', '1'] }] },
    { op: 'solve', budget: '1.5.6', durationLimit: '1' },
  ]));
  assert.equal(out[0].ok, false);
  assert.equal(out[0].error, 'E_RATIONAL');
  assert.equal(out[1].ok, false);
  assert.equal(out[1].error, 'E_RATIONAL');
});

test('CLI reports E_UNSAT when no feasible plan exists', () => {
  const out = runCli(JSON.stringify([
    { op: 'import', tasks: [{ id: 'x', priority: '1', cost: ['0', '1'], duration: ['0', '1'] }] },
    { op: 'solve', budget: '-1', durationLimit: '1' },
  ]));
  assert.equal(out[0].ok, true);
  assert.equal(out[1].ok, false);
  assert.equal(out[1].error, 'E_UNSAT');
});

test('CLI rolls back a cyclic batch and keeps the previous plan', () => {
  const out = runCli(JSON.stringify([
    { op: 'import', tasks: [{ id: 'a', priority: '2', cost: ['0', '1'], duration: ['0', '1'] }] },
    { op: 'import', tasks: [
      { id: 'c', priority: '1', cost: ['0', '1'], duration: ['0', '1'], requires: ['d'] },
      { id: 'd', priority: '1', cost: ['0', '1'], duration: ['0', '1'], requires: ['c'] },
    ] },
    { op: 'solve', budget: '1', durationLimit: '1' },
  ]));
  assert.equal(out[0].ok, true);
  assert.equal(out[1].ok, false);
  assert.equal(out[1].error, 'E_CYCLE');
  assert.equal(out[2].ok, true);
  assert.deepEqual(out[2].selected, ['a']);
});
