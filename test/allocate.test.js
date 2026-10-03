'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createState, allocate } = require('../index');

function alloc(input) {
  return allocate(createState(input));
}

test('FEFO: earliest expiry first, batch id breaks ties', () => {
  const result = alloc({
    batches: [
      { id: 'B2', material: 'M1', qty: 3, expiry: '2026-03-01', status: 'OK' },
      { id: 'B1', material: 'M1', qty: 3, expiry: '2026-02-01', status: 'OK' },
      { id: 'B3', material: 'M1', qty: 3, expiry: '2026-02-01', status: 'OK' },
    ],
    orders: [{ id: 'O1', due: '2026-01-10', lines: [{ line: 1, material: 'M1', qty: 5 }] }],
  });
  // B1 and B3 share the earliest expiry; B1 wins the tie, then B3, then B2.
  assert.deepEqual(
    result.reservations.map((r) => [r.batchId, r.qty]),
    [['B1', 3], ['B3', 2]]
  );
});

test('reservation order: due date, then order id, then line number', () => {
  const result = alloc({
    batches: [{ id: 'B1', material: 'M1', qty: 2, expiry: '2026-02-01', status: 'OK' }],
    orders: [
      { id: 'O2', due: '2026-01-10', lines: [{ line: 1, material: 'M1', qty: 1 }] },
      { id: 'O1', due: '2026-01-10', lines: [{ line: 2, material: 'M1', qty: 1 }, { line: 1, material: 'M1', qty: 1 }] },
    ],
  });
  // O1 sorts before O2 (same due, smaller id); within O1, line 1 before line 2.
  assert.deepEqual(
    result.reservations.map((r) => [r.orderId, r.line, r.qty]),
    [['O1', 1, 1], ['O1', 2, 1]]
  );
  assert.equal(result.orders.find((o) => o.orderId === 'O2').status, 'SHORT');
});

test('HOLD and expired batches are excluded', () => {
  const result = alloc({
    now: '2026-02-15',
    batches: [
      { id: 'B1', material: 'M1', qty: 5, expiry: '2026-01-01', status: 'OK' },   // expired
      { id: 'B2', material: 'M1', qty: 5, expiry: '2026-03-01', status: 'HOLD' }, // frozen
      { id: 'B3', material: 'M1', qty: 2, expiry: '2026-03-01', status: 'OK' },
    ],
    orders: [{ id: 'O1', due: '2026-01-10', lines: [{ line: 1, material: 'M1', qty: 4 }] }],
  });
  assert.deepEqual(result.reservations.map((r) => [r.batchId, r.qty]), [['B3', 2]]);
  const order = result.orders[0];
  assert.equal(order.status, 'SHORT');
  assert.deepEqual(order.certificate.missing, [
    { line: 1, material: 'M1', required: 4, reserved: 2, short: 2 },
  ]);
});

test('substitute stock is used when primary is insufficient', () => {
  const result = alloc({
    substitutes: [['M1', 'M2']],
    batches: [
      { id: 'B1', material: 'M1', qty: 2, expiry: '2026-02-01', status: 'OK' },
      { id: 'B2', material: 'M2', qty: 3, expiry: '2026-03-01', status: 'OK' },
    ],
    orders: [{ id: 'O1', due: '2026-01-10', lines: [{ line: 1, material: 'M1', qty: 4 }] }],
  });
  assert.deepEqual(
    result.reservations.map((r) => [r.batchId, r.batchMaterial, r.qty]),
    [['B1', 'M1', 2], ['B2', 'M2', 2]]
  );
  assert.equal(result.orders[0].status, 'COMPLETE');
});

test('substitution is transitive but not symmetric', () => {
  const result = alloc({
    substitutes: [['M1', 'M2'], ['M2', 'M3']],
    batches: [{ id: 'B1', material: 'M3', qty: 2, expiry: '2026-02-01', status: 'OK' }],
    orders: [
      { id: 'O1', due: '2026-01-10', lines: [{ line: 1, material: 'M1', qty: 2 }] },
      { id: 'O2', due: '2026-01-11', lines: [{ line: 1, material: 'M2', qty: 2 }] },
    ],
  });
  // M1 can be fulfilled by M3 (transitively); nothing can fulfil M3 itself here.
  assert.equal(result.orders.find((o) => o.orderId === 'O1').status, 'COMPLETE');
  assert.equal(result.orders.find((o) => o.orderId === 'O2').status, 'SHORT');
});

test('certificate lists missing materials and attempted substitutes', () => {
  const result = alloc({
    substitutes: [['M1', 'M2']],
    batches: [{ id: 'B1', material: 'M2', qty: 1, expiry: '2026-02-01', status: 'OK' }],
    orders: [{ id: 'O1', due: '2026-01-10', lines: [{ line: 1, material: 'M1', qty: 3 }] }],
  });
  const cert = result.orders[0].certificate;
  assert.deepEqual(cert.missing, [{ line: 1, material: 'M1', required: 3, reserved: 1, short: 2 }]);
  assert.deepEqual(cert.attemptedSubstitutes, [
    { line: 1, material: 'M1', tried: [{ material: 'M1', available: 0 }, { material: 'M2', available: 1 }] },
  ]);
});
