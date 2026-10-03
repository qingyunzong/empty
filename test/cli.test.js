import test from 'node:test';
import assert from 'node:assert/strict';
import { runCommands } from '../src/app.js';

function runCli(stdin) {
  return runCommands(stdin);
}

test('end-to-end: import, solve, undo, redo via stdin JSON', () => {
  const commands = [
    { op: 'import', tasks: [
      { id: 'a', priority: '3/2', cost: ['1/2', 1], duration: [0, 1] },
      { id: 'b', priority: 2, cost: [1, '5/2'], duration: [0, 1], precedence: ['a'] },
    ] },
    { op: 'solve', budget: '7/2', durationLimit: 2 },
    { op: 'undo' },
    { op: 'solve', budget: 10, durationLimit: 10 },
    { op: 'redo' },
    { op: 'solve', budget: '7/2', durationLimit: 2 },
  ];
  const results = runCli(JSON.stringify(commands));
  assert.equal(results.length, 6);

  assert.deepEqual(results[0], { ok: true, imported: 2 });

  const solved = results[1];
  assert.equal(solved.ok, true);
  assert.deepEqual(solved.selected, ['a', 'b']); // worst cost 1 + 5/2 = 7/2 == budget
  assert.equal(solved.priority, '7/2');
  assert.deepEqual(solved.costInterval, ['3/2', '7/2']);
  assert.equal(solved.certificate.method, 'exact-enumeration');

  assert.deepEqual(results[2], { ok: true, undone: 2 });

  const afterUndo = results[3];
  assert.equal(afterUndo.ok, true);
  assert.deepEqual(afterUndo.selected, []);
  assert.equal(afterUndo.priority, '0');

  assert.deepEqual(results[4], { ok: true, redone: 2 });
  assert.deepEqual(results[5].selected, ['a', 'b']);
});

test('CLI reports E_RATIONAL for invalid fractions', () => {
  const results = runCli(JSON.stringify([
    { op: 'import', tasks: [{ id: 'x', priority: 'abc', cost: [0, 1], duration: [0, 1] }] },
  ]));
  assert.equal(results[0].ok, false);
  assert.equal(results[0].error, 'E_RATIONAL');
});

test('CLI reports E_UNSAT when no feasible selection exists', () => {
  const results = runCli(JSON.stringify([{ op: 'solve', budget: -1, durationLimit: 0 }]));
  assert.equal(results[0].ok, false);
  assert.equal(results[0].error, 'E_UNSAT');
});

test('CLI rolls back a cyclic batch and keeps the previous plan', () => {
  const results = runCli(JSON.stringify([
    { op: 'import', tasks: [{ id: 'a', priority: 1, cost: [0, 1], duration: [0, 0] }] },
    { op: 'import', tasks: [
      { id: 'c', priority: 1, cost: [0, 1], duration: [0, 0], precedence: ['d'] },
      { id: 'd', priority: 1, cost: [0, 1], duration: [0, 0], precedence: ['c'] },
    ] },
    { op: 'solve', budget: 5, durationLimit: 5 },
  ]));
  assert.equal(results[1].ok, false);
  assert.equal(results[1].error, 'E_CYCLE');
  assert.equal(results[2].ok, true);
  assert.deepEqual(results[2].selected, ['a']);
});

test('CLI accepts newline-delimited JSON commands', () => {
  const results = runCli(
    '{"op":"import","tasks":[{"id":"a","priority":1,"cost":[0,1],"duration":[0,0]}]}\n' +
    '{"op":"list"}\n',
  );
  assert.equal(results[0].ok, true);
  assert.equal(results[1].tasks.length, 1);
  assert.equal(results[1].tasks[0].priority, '1');
});
