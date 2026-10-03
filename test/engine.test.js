'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../index');

function makeEngine(input) {
  return new Engine(input);
}

test('freezing a batch rearranges later orders without preempting earlier ones', () => {
  const engine = makeEngine({
    batches: [
      { id: 'B1', material: 'M1', qty: 5, expiry: '2026-02-01', status: 'OK' },
      { id: 'B2', material: 'M1', qty: 5, expiry: '2026-03-01', status: 'OK' },
      { id: 'B3', material: 'M1', qty: 5, expiry: '2026-04-01', status: 'OK' },
    ],
    orders: [
      { id: 'O1', due: '2026-01-10', lines: [{ line: 1, material: 'M1', qty: 5 }] },
      { id: 'O2', due: '2026-01-20', lines: [{ line: 1, material: 'M1', qty: 5 }] },
      { id: 'O3', due: '2026-01-30', lines: [{ line: 1, material: 'M1', qty: 5 }] },
    ],
  });
  const before = engine.result();
  assert.deepEqual(
    before.reservations.map((r) => [r.orderId, r.batchId]),
    [['O1', 'B1'], ['O2', 'B2'], ['O3', 'B3']]
  );

  const entry = engine.apply({ op: 'freezeBatch', batchId: 'B2' });
  assert.equal(entry.ok, true);

  const after = engine.result();
  // Earlier order O1 keeps its exact reservation: no preemption.
  assert.deepEqual(
    after.reservations.filter((r) => r.orderId === 'O1'),
    before.reservations.filter((r) => r.orderId === 'O1')
  );
  // The loss propagates to the latest order only: O2 shifts to B3, O3 goes SHORT.
  assert.deepEqual(
    after.reservations.map((r) => [r.orderId, r.batchId]),
    [['O1', 'B1'], ['O2', 'B3']]
  );
  assert.equal(after.orders.find((o) => o.orderId === 'O3').status, 'SHORT');
  assert.deepEqual(after.orders.find((o) => o.orderId === 'O3').certificate.missing, [
    { line: 1, material: 'M1', required: 5, reserved: 0, short: 5 },
  ]);
});

test('frozen earliest-expiry batch: earlier order absorbs later stock, later order shorts', () => {
  const engine = makeEngine({
    batches: [
      { id: 'B1', material: 'M1', qty: 5, expiry: '2026-02-01', status: 'OK' },
      { id: 'B2', material: 'M1', qty: 5, expiry: '2026-03-01', status: 'OK' },
    ],
    orders: [
      { id: 'O1', due: '2026-01-10', lines: [{ line: 1, material: 'M1', qty: 5 }] },
      { id: 'O2', due: '2026-01-20', lines: [{ line: 1, material: 'M1', qty: 5 }] },
    ],
  });
  engine.apply({ op: 'freezeBatch', batchId: 'B1' });
  const result = engine.result();
  assert.equal(result.orders.find((o) => o.orderId === 'O1').status, 'COMPLETE');
  assert.deepEqual(result.reservations.map((r) => [r.orderId, r.batchId]), [['O1', 'B2']]);
  assert.equal(result.orders.find((o) => o.orderId === 'O2').status, 'SHORT');
});

test('HOLD: line first shifts within itself (incl. substitutes), SHORT only when impossible', () => {
  const engine = makeEngine({
    substitutes: [['M1', 'M2']],
    batches: [
      { id: 'B1', material: 'M1', qty: 5, expiry: '2026-02-01', status: 'OK' },
      { id: 'B2', material: 'M1', qty: 3, expiry: '2026-03-01', status: 'OK' },
      { id: 'B3', material: 'M2', qty: 5, expiry: '2026-04-01', status: 'OK' },
    ],
    orders: [{ id: 'O1', due: '2026-01-10', lines: [{ line: 1, material: 'M1', qty: 8 }] }],
  });
  assert.equal(engine.result().orders[0].status, 'COMPLETE');

  // Freeze B1: the line shifts onto B2 + substitute B3 and stays COMPLETE.
  engine.apply({ op: 'freezeBatch', batchId: 'B1' });
  let result = engine.result();
  assert.equal(result.orders[0].status, 'COMPLETE');
  assert.deepEqual(
    result.reservations.map((r) => [r.batchId, r.qty]),
    [['B2', 3], ['B3', 5]]
  );

  // Freeze B2 as well: only 5 of 8 can be covered -> SHORT with certificate.
  engine.apply({ op: 'freezeBatch', batchId: 'B2' });
  result = engine.result();
  const order = result.orders[0];
  assert.equal(order.status, 'SHORT');
  assert.deepEqual(order.certificate.missing, [
    { line: 1, material: 'M1', required: 8, reserved: 5, short: 3 },
  ]);
  assert.deepEqual(order.certificate.attemptedSubstitutes, [
    { line: 1, material: 'M1', tried: [{ material: 'M1', available: 0 }, { material: 'M2', available: 5 }] },
  ]);

  // Releasing B1 restores the kit.
  engine.apply({ op: 'releaseBatch', batchId: 'B1' });
  assert.equal(engine.result().orders[0].status, 'COMPLETE');
});

test('substitute correction: removing an edge invalidates dependent reservations', () => {
  const engine = makeEngine({
    substitutes: [['M1', 'M2']],
    batches: [{ id: 'B1', material: 'M2', qty: 4, expiry: '2026-02-01', status: 'OK' }],
    orders: [{ id: 'O1', due: '2026-01-10', lines: [{ line: 1, material: 'M1', qty: 4 }] }],
  });
  assert.equal(engine.result().orders[0].status, 'COMPLETE');

  const entry = engine.apply({ op: 'removeSubstitute', from: 'M1', to: 'M2' });
  assert.equal(entry.ok, true);
  assert.equal(engine.result().orders[0].status, 'SHORT');
  assert.equal(engine.result().reservations.length, 0);

  engine.apply({ op: 'addSubstitute', from: 'M1', to: 'M2' });
  assert.equal(engine.result().orders[0].status, 'COMPLETE');
});

test('incremental order add/remove recomputes reservations', () => {
  const engine = makeEngine({
    batches: [{ id: 'B1', material: 'M1', qty: 5, expiry: '2026-02-01', status: 'OK' }],
    orders: [{ id: 'O1', due: '2026-01-10', lines: [{ line: 1, material: 'M1', qty: 5 }] }],
  });
  engine.apply({
    op: 'addOrder',
    order: { id: 'O0', due: '2026-01-05', lines: [{ line: 1, material: 'M1', qty: 5 }] },
  });
  // New earlier-due order takes the stock; O1 goes short.
  assert.equal(engine.result().orders.find((o) => o.orderId === 'O0').status, 'COMPLETE');
  assert.equal(engine.result().orders.find((o) => o.orderId === 'O1').status, 'SHORT');

  engine.apply({ op: 'removeOrder', orderId: 'O0' });
  assert.equal(engine.result().orders.find((o) => o.orderId === 'O1').status, 'COMPLETE');
});

test('undo/redo walks the history; a new command clears the redo stack', () => {
  const engine = makeEngine({
    batches: [{ id: 'B1', material: 'M1', qty: 5, expiry: '2026-02-01', status: 'OK' }],
    orders: [{ id: 'O1', due: '2026-01-10', lines: [{ line: 1, material: 'M1', qty: 5 }] }],
  });
  const initial = engine.result();

  engine.apply({ op: 'freezeBatch', batchId: 'B1' });
  assert.equal(engine.result().orders[0].status, 'SHORT');

  assert.equal(engine.apply({ op: 'undo' }).ok, true);
  assert.deepEqual(engine.result(), initial);

  assert.equal(engine.apply({ op: 'redo' }).ok, true);
  assert.equal(engine.result().orders[0].status, 'SHORT');

  engine.apply({ op: 'undo' });
  engine.apply({ op: 'consumeBatch', batchId: 'B1', qty: 2 }); // clears redo
  const redo = engine.apply({ op: 'redo' });
  assert.equal(redo.ok, false);
  assert.equal(redo.code, 'REDO_EMPTY');

  engine.apply({ op: 'undo' });
  const undo = engine.apply({ op: 'undo' });
  assert.equal(undo.ok, false);
  assert.equal(undo.code, 'UNDO_EMPTY');
});

test('error cases: cycle, over-deduction, unknown batch, unknown order, duplicates', () => {
  const engine = makeEngine({
    substitutes: [['M1', 'M2']],
    batches: [{ id: 'B1', material: 'M1', qty: 5, expiry: '2026-02-01', status: 'OK' }],
    orders: [{ id: 'O1', due: '2026-01-10', lines: [{ line: 1, material: 'M1', qty: 1 }] }],
  });

  const cycle = engine.apply({ op: 'addSubstitute', from: 'M2', to: 'M1' });
  assert.equal(cycle.ok, false);
  assert.equal(cycle.code, 'CYCLE');
  assert.match(cycle.error, /cycle/);

  const over = engine.apply({ op: 'consumeBatch', batchId: 'B1', qty: 6 });
  assert.equal(over.ok, false);
  assert.equal(over.code, 'OVER_DEDUCTION');
  assert.match(over.error, /over-deduction/);

  const unknownFreeze = engine.apply({ op: 'freezeBatch', batchId: 'NOPE' });
  assert.equal(unknownFreeze.ok, false);
  assert.equal(unknownFreeze.code, 'UNKNOWN_BATCH');

  const unknownConsume = engine.apply({ op: 'consumeBatch', batchId: 'NOPE', qty: 1 });
  assert.equal(unknownConsume.ok, false);
  assert.equal(unknownConsume.code, 'UNKNOWN_BATCH');

  const unknownOrder = engine.apply({ op: 'removeOrder', orderId: 'NOPE' });
  assert.equal(unknownOrder.ok, false);
  assert.equal(unknownOrder.code, 'UNKNOWN_ORDER');

  const dupOrder = engine.apply({
    op: 'addOrder',
    order: { id: 'O1', due: '2026-01-11', lines: [{ line: 1, material: 'M1', qty: 1 }] },
  });
  assert.equal(dupOrder.ok, false);
  assert.equal(dupOrder.code, 'DUPLICATE');

  const dupBatch = engine.apply({
    op: 'addBatch',
    batch: { id: 'B1', material: 'M1', qty: 1, expiry: '2026-05-01' },
  });
  assert.equal(dupBatch.ok, false);
  assert.equal(dupBatch.code, 'DUPLICATE');

  const unknownSub = engine.apply({ op: 'removeSubstitute', from: 'M1', to: 'M9' });
  assert.equal(unknownSub.ok, false);
  assert.equal(unknownSub.code, 'UNKNOWN_SUBSTITUTE');

  // Failed commands must not mutate state.
  assert.equal(engine.state.batches.find((b) => b.id === 'B1').qty, 5);
  assert.equal(engine.state.batches.find((b) => b.id === 'B1').status, 'OK');
  assert.deepEqual(engine.state.substitutes, [['M1', 'M2']]);
  assert.equal(engine.state.orders.length, 1);
});

test('initial input with a substitution cycle is rejected', () => {
  assert.throws(
    () => makeEngine({ substitutes: [['M1', 'M2'], ['M2', 'M1']] }),
    (err) => err.code === 'CYCLE'
  );
});

test('consumeBatch reduces stock and propagates to shortages', () => {
  const engine = makeEngine({
    batches: [{ id: 'B1', material: 'M1', qty: 5, expiry: '2026-02-01', status: 'OK' }],
    orders: [{ id: 'O1', due: '2026-01-10', lines: [{ line: 1, material: 'M1', qty: 5 }] }],
  });
  const entry = engine.apply({ op: 'consumeBatch', batchId: 'B1', qty: 2 });
  assert.equal(entry.ok, true);
  const order = engine.result().orders[0];
  assert.equal(order.status, 'SHORT');
  assert.deepEqual(order.certificate.missing, [
    { line: 1, material: 'M1', required: 5, reserved: 3, short: 2 },
  ]);
});
