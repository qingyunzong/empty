'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Ledger, LedgerError } = require('../index');

function buildCycleLedger() {
  const ledger = new Ledger();
  ledger.applyEvent({ op: 'add-edge', id: 'e1', from: 'A', to: 'B', lower: 2, upper: 5 });
  ledger.applyEvent({ op: 'add-edge', id: 'e2', from: 'B', to: 'C', lower: 1, upper: 4 });
  ledger.applyEvent({ op: 'add-edge', id: 'e3', from: 'C', to: 'A', lower: 3, upper: 6 });
  return ledger;
}

test('update-edge flips feasibility and undo restores it', () => {
  const ledger = buildCycleLedger();
  assert.equal(ledger.evaluate().feasible, true);

  // Tighten C->A below what the cycle must push back: infeasible.
  ledger.applyEvent({ op: 'update-edge', id: 'e4', from: 'C', to: 'A', lower: 0, upper: 1 });
  let result = ledger.evaluate();
  assert.equal(result.feasible, false);
  assert.ok(!('flows' in result));
  assert.ok(result.cut.violation > 0);

  // Undo the update by event id: feasible again.
  ledger.undo('e4');
  result = ledger.evaluate();
  assert.equal(result.feasible, true);
  assert.ok(result.flows);

  // Redo by event id: infeasible again.
  ledger.redo('e4');
  assert.equal(ledger.evaluate().feasible, false);
});

test('undo/redo of remove-edge by event id', () => {
  const ledger = buildCycleLedger();
  ledger.applyEvent({ op: 'remove-edge', id: 'e4', from: 'C', to: 'A' });
  assert.equal(ledger.evaluate().feasible, false);
  ledger.undo('e4');
  assert.equal(ledger.evaluate().feasible, true);
  ledger.redo('e4');
  assert.equal(ledger.evaluate().feasible, false);
});

test('undo/redo of add-edge by event id', () => {
  const ledger = new Ledger();
  ledger.applyEvent({ op: 'add-edge', id: 'e1', from: 'A', to: 'B', lower: 2, upper: 5 });
  ledger.applyEvent({ op: 'add-edge', id: 'e2', from: 'B', to: 'A', lower: 3, upper: 5 });
  assert.equal(ledger.evaluate().feasible, true);
  ledger.undo('e2');
  assert.equal(ledger.evaluate().feasible, false); // B owes 3 with no return edge
  ledger.redo('e2');
  assert.equal(ledger.evaluate().feasible, true);
});

test('undo mismatch raises UNDO_MISMATCH', () => {
  const ledger = buildCycleLedger();
  assert.throws(() => ledger.undo('e1'), (err) => err instanceof LedgerError && err.code === 'UNDO_MISMATCH');
  assert.throws(() => ledger.undo('nope'), (err) => err.code === 'UNDO_MISMATCH');
});

test('redo mismatch raises REDO_MISMATCH', () => {
  const ledger = buildCycleLedger();
  assert.throws(() => ledger.redo('e3'), (err) => err.code === 'REDO_MISMATCH');
  ledger.undo('e3');
  assert.throws(() => ledger.redo('e2'), (err) => err.code === 'REDO_MISMATCH');
  ledger.redo('e3');
  assert.throws(() => ledger.redo('e3'), (err) => err.code === 'REDO_MISMATCH');
});

test('new mutation clears the redo stack', () => {
  const ledger = buildCycleLedger();
  ledger.undo('e3');
  ledger.applyEvent({ op: 'add-edge', id: 'e4', from: 'C', to: 'A', lower: 0, upper: 9 });
  assert.throws(() => ledger.redo('e3'), (err) => err.code === 'REDO_MISMATCH');
});

test('lower greater than upper is rejected', () => {
  const ledger = new Ledger();
  assert.throws(
    () => ledger.applyEvent({ op: 'add-edge', id: 'e1', from: 'A', to: 'B', lower: 4, upper: 2 }),
    (err) => err.code === 'LOWER_EXCEEDS_UPPER',
  );
  ledger.applyEvent({ op: 'add-edge', id: 'e2', from: 'A', to: 'B', lower: 1, upper: 3 });
  assert.throws(
    () => ledger.applyEvent({ op: 'update-edge', id: 'e3', from: 'A', to: 'B', lower: 5 }),
    (err) => err.code === 'LOWER_EXCEEDS_UPPER',
  );
});

test('negative capacity is rejected', () => {
  const ledger = new Ledger();
  assert.throws(
    () => ledger.applyEvent({ op: 'add-edge', id: 'e1', from: 'A', to: 'B', lower: -1, upper: 2 }),
    (err) => err.code === 'NEGATIVE_CAPACITY',
  );
  assert.throws(
    () => ledger.applyEvent({ op: 'add-edge', id: 'e2', from: 'A', to: 'B', lower: 0, upper: -3 }),
    (err) => err.code === 'NEGATIVE_CAPACITY',
  );
});

test('unknown node and unknown edge are rejected', () => {
  const ledger = buildCycleLedger();
  assert.throws(
    () => ledger.applyEvent({ op: 'update-edge', id: 'e4', from: 'A', to: 'Z', upper: 1 }),
    (err) => err.code === 'UNKNOWN_NODE',
  );
  assert.throws(
    () => ledger.applyEvent({ op: 'remove-edge', id: 'e5', from: 'Z', to: 'A' }),
    (err) => err.code === 'UNKNOWN_NODE',
  );
  assert.throws(
    () => ledger.applyEvent({ op: 'update-edge', id: 'e6', from: 'A', to: 'C', upper: 1 }),
    (err) => err.code === 'UNKNOWN_EDGE',
  );
});

test('duplicate edge and duplicate event id are rejected', () => {
  const ledger = buildCycleLedger();
  assert.throws(
    () => ledger.applyEvent({ op: 'add-edge', id: 'e4', from: 'A', to: 'B', lower: 0, upper: 1 }),
    (err) => err.code === 'EDGE_EXISTS',
  );
  assert.throws(
    () => ledger.applyEvent({ op: 'add-edge', id: 'e1', from: 'X', to: 'Y', lower: 0, upper: 1 }),
    (err) => err.code === 'DUPLICATE_EVENT_ID',
  );
});

test('partial update keeps the untouched bound', () => {
  const ledger = new Ledger();
  ledger.applyEvent({ op: 'add-edge', id: 'e1', from: 'A', to: 'B', lower: 2, upper: 5 });
  ledger.applyEvent({ op: 'update-edge', id: 'e2', from: 'A', to: 'B', upper: 7 });
  assert.deepEqual(ledger.edges.get('A->B'), { from: 'A', to: 'B', lower: 2, upper: 7 });
  ledger.undo('e2');
  assert.deepEqual(ledger.edges.get('A->B'), { from: 'A', to: 'B', lower: 2, upper: 5 });
});
