'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OrderRepo } = require('../src/repo');
const { UnknownOrderError, InvalidPatchError } = require('../src/errors');

function makeRepo() {
  return new OrderRepo([
    { id: 'o1', status: 'created', assignee: 'alice', priority: 'low' },
  ]);
}

test('apply updates fields and returns the inverse patch', () => {
  const repo = makeRepo();
  const inverse = repo.apply({ id: 'o1', changes: { assignee: 'bob', priority: 'high' } });
  assert.equal(repo.get('o1').assignee, 'bob');
  assert.equal(repo.get('o1').priority, 'high');
  assert.deepEqual(inverse, { id: 'o1', changes: { assignee: 'alice', priority: 'low' } });
});

test('apply enforces the status state machine', () => {
  const repo = makeRepo();
  assert.throws(
    () => repo.apply({ id: 'o1', changes: { status: 'done' } }),
    (err) => err instanceof InvalidPatchError && err.exitCode === 2
  );
  repo.apply({ id: 'o1', changes: { status: 'assigned' } });
  repo.apply({ id: 'o1', changes: { status: 'in_progress' } });
  repo.apply({ id: 'o1', changes: { status: 'done' } });
  assert.equal(repo.get('o1').status, 'done');
});

test('apply allows cancel from the first three states', () => {
  for (const path of [['created'], ['created', 'assigned'], ['created', 'assigned', 'in_progress']]) {
    const repo = makeRepo();
    for (const status of path.slice(1)) {
      repo.apply({ id: 'o1', changes: { status } });
    }
    repo.apply({ id: 'o1', changes: { status: 'canceled' } });
    assert.equal(repo.get('o1').status, 'canceled');
  }
});

test('terminal orders reject any further patch', () => {
  const repo = makeRepo();
  repo.apply({ id: 'o1', changes: { status: 'canceled' } });
  assert.throws(
    () => repo.apply({ id: 'o1', changes: { assignee: 'bob' } }),
    (err) => err instanceof InvalidPatchError && err.exitCode === 2
  );
});

test('apply rejects unknown orders and malformed patches with exit code 2', () => {
  const repo = makeRepo();
  assert.throws(
    () => repo.apply({ id: 'nope', changes: { assignee: 'bob' } }),
    (err) => err instanceof UnknownOrderError && err.exitCode === 2
  );
  assert.throws(
    () => repo.apply({ id: 'o1', changes: { id: 'other' } }),
    (err) => err instanceof InvalidPatchError && err.exitCode === 2
  );
  assert.throws(
    () => repo.apply({ id: 'o1', changes: { status: 'bogus' } }),
    (err) => err instanceof InvalidPatchError && err.exitCode === 2
  );
});

test('undo restores the previous state via the inverse patch', () => {
  const repo = makeRepo();
  repo.apply({ id: 'o1', changes: { assignee: 'bob' } });
  repo.apply({ id: 'o1', changes: { status: 'assigned' } });
  assert.equal(repo.undo(), true);
  assert.equal(repo.get('o1').status, 'created');
  assert.equal(repo.undo(), true);
  assert.equal(repo.get('o1').assignee, 'alice');
  assert.equal(repo.undo(), false);
});

test('redo re-applies undone patches while respecting the state machine', () => {
  const repo = makeRepo();
  repo.apply({ id: 'o1', changes: { status: 'assigned' } });
  repo.apply({ id: 'o1', changes: { status: 'in_progress' } });
  assert.equal(repo.undo(), true);
  assert.equal(repo.get('o1').status, 'assigned');
  assert.equal(repo.redo(), true);
  assert.equal(repo.get('o1').status, 'in_progress');
  assert.equal(repo.redo(), false);
});

test('a new apply clears the redo stack', () => {
  const repo = makeRepo();
  repo.apply({ id: 'o1', changes: { assignee: 'bob' } });
  repo.undo();
  repo.apply({ id: 'o1', changes: { priority: 'high' } });
  assert.equal(repo.redo(), false);
});

test('undo of a status change followed by redo stays legal', () => {
  const repo = makeRepo();
  repo.apply({ id: 'o1', changes: { status: 'assigned' } });
  repo.apply({ id: 'o1', changes: { status: 'in_progress' } });
  repo.apply({ id: 'o1', changes: { status: 'done' } });
  assert.equal(repo.undo(), true);
  assert.equal(repo.get('o1').status, 'in_progress');
  assert.equal(repo.redo(), true);
  assert.equal(repo.get('o1').status, 'done');
});
