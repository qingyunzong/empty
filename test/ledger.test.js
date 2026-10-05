import test from 'node:test';
import assert from 'node:assert/strict';
import { ClearingNetwork, ClearingError } from '../src/ledger.js';

function expectError(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ClearingError);
    assert.equal(err.code, code);
    return true;
  });
}

test('acceptance 3: update and undo change feasibility', () => {
  const net = new ClearingNetwork();
  let status = net.addEdge('e1', { id: 'ab', from: 'A', to: 'B', lower: 2, upper: 3 });
  assert.equal(status.feasible, false, 'no return path yet');
  status = net.addEdge('e2', { id: 'ba', from: 'B', to: 'A', lower: 0, upper: 1 });
  assert.equal(status.feasible, false, 'return capacity too small');
  status = net.updateEdge('e3', 'ba', { upper: 2 });
  assert.equal(status.feasible, true, 'update makes the network feasible');
  assert.equal(status.flow.ab, 2);
  assert.equal(status.flow.ba, 2);
  status = net.undo('e3');
  assert.equal(status.feasible, false, 'undo restores infeasibility');
  assert.equal('flow' in status, false);
  status = net.redo('e3');
  assert.equal(status.feasible, true, 'redo restores feasibility');
});

test('remove-edge and undo of remove-edge', () => {
  const net = new ClearingNetwork();
  net.addEdge('e1', { id: 'ab', from: 'A', to: 'B', lower: 1, upper: 2 });
  net.addEdge('e2', { id: 'ba', from: 'B', to: 'A', lower: 1, upper: 2 });
  let status = net.removeEdge('e3', 'ba');
  assert.equal(status.feasible, false);
  status = net.undo('e3');
  assert.equal(status.feasible, true);
});

test('new mutation clears the redo stack', () => {
  const net = new ClearingNetwork();
  net.addEdge('e1', { id: 'ab', from: 'A', to: 'B', lower: 1, upper: 2 });
  net.undo('e1');
  net.addEdge('e2', { id: 'ba', from: 'B', to: 'A', lower: 0, upper: 2 });
  expectError(() => net.redo('e1'), 'NOTHING_TO_REDO');
});

test('undo/redo require matching event ids', () => {
  const net = new ClearingNetwork();
  net.addEdge('e1', { id: 'ab', from: 'A', to: 'B', lower: 1, upper: 2 });
  net.addEdge('e2', { id: 'ba', from: 'B', to: 'A', lower: 1, upper: 2 });
  expectError(() => net.undo('e1'), 'UNDO_MISMATCH');
  net.undo('e2');
  expectError(() => net.redo('e1'), 'REDO_MISMATCH');
  net.redo('e2');
  expectError(() => net.undo('nope'), 'UNDO_MISMATCH');
});

test('undo/redo on empty history', () => {
  const net = new ClearingNetwork();
  expectError(() => net.undo('e1'), 'NOTHING_TO_UNDO');
  expectError(() => net.redo('e1'), 'NOTHING_TO_REDO');
});

test('lower bound greater than upper bound is rejected', () => {
  const net = new ClearingNetwork();
  expectError(
    () => net.addEdge('e1', { id: 'ab', from: 'A', to: 'B', lower: 5, upper: 3 }),
    'INVALID_BOUNDS',
  );
  net.addEdge('e2', { id: 'ab', from: 'A', to: 'B', lower: 1, upper: 3 });
  expectError(() => net.updateEdge('e3', 'ab', { lower: 4 }), 'INVALID_BOUNDS');
});

test('negative capacity is rejected', () => {
  const net = new ClearingNetwork();
  expectError(
    () => net.addEdge('e1', { id: 'ab', from: 'A', to: 'B', lower: -1, upper: 3 }),
    'NEGATIVE_CAPACITY',
  );
  expectError(
    () => net.addEdge('e1', { id: 'ab', from: 'A', to: 'B', lower: 0, upper: -2 }),
    'NEGATIVE_CAPACITY',
  );
  net.addEdge('e2', { id: 'ab', from: 'A', to: 'B', lower: 0, upper: 3 });
  expectError(() => net.updateEdge('e3', 'ab', { upper: -1 }), 'NEGATIVE_CAPACITY');
});

test('unknown edge and unknown node are rejected', () => {
  const net = new ClearingNetwork();
  expectError(() => net.updateEdge('e1', 'ghost', { upper: 1 }), 'UNKNOWN_EDGE');
  expectError(() => net.removeEdge('e2', 'ghost'), 'UNKNOWN_EDGE');
  expectError(() => net.nodeFlow('ghost'), 'UNKNOWN_NODE');
});

test('duplicate event ids and duplicate edge ids are rejected', () => {
  const net = new ClearingNetwork();
  net.addEdge('e1', { id: 'ab', from: 'A', to: 'B', lower: 0, upper: 1 });
  expectError(
    () => net.addEdge('e1', { id: 'xy', from: 'X', to: 'Y', lower: 0, upper: 1 }),
    'DUPLICATE_EVENT',
  );
  expectError(
    () => net.addEdge('e2', { id: 'ab', from: 'A', to: 'B', lower: 0, upper: 1 }),
    'EDGE_EXISTS',
  );
});

test('failed mutations leave the state untouched', () => {
  const net = new ClearingNetwork();
  net.addEdge('e1', { id: 'ab', from: 'A', to: 'B', lower: 1, upper: 2 });
  expectError(
    () => net.addEdge('e2', { id: 'ba', from: 'B', to: 'A', lower: 9, upper: 1 }),
    'INVALID_BOUNDS',
  );
  const status = net.addEdge('e3', { id: 'ba', from: 'B', to: 'A', lower: 1, upper: 2 });
  assert.equal(status.feasible, true);
});

test('node-flow reports imbalance and settled flow', () => {
  const net = new ClearingNetwork();
  net.addEdge('e1', { id: 'ab', from: 'A', to: 'B', lower: 2, upper: 4 });
  net.addEdge('e2', { id: 'ba', from: 'B', to: 'A', lower: 0, upper: 4 });
  const info = net.nodeFlow('B');
  assert.equal(info.imbalance, 2);
  assert.equal(info.inflow, info.outflow);
});

test('undo/redo across a longer event history', () => {
  const net = new ClearingNetwork();
  net.addEdge('e1', { id: 'ab', from: 'A', to: 'B', lower: 2, upper: 5 });
  net.addEdge('e2', { id: 'bc', from: 'B', to: 'C', lower: 1, upper: 5 });
  net.addEdge('e3', { id: 'ca', from: 'C', to: 'A', lower: 1, upper: 5 });
  assert.equal(net.status().feasible, true);
  net.undo('e3');
  net.undo('e2');
  assert.equal(net.status().feasible, false);
  net.redo('e2');
  net.redo('e3');
  assert.equal(net.status().feasible, true);
});
