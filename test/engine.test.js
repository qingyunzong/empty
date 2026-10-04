import test from 'node:test';
import assert from 'node:assert/strict';
import { KittingEngine, KittingError } from '../src/engine.js';

function reservationsOf(report, orderId, lineId) {
  const order = report.orders.find((o) => o.orderId === orderId);
  const line = order.lines.find((l) => l.lineId === lineId);
  return line.reservations;
}

test('substitute stock is allocated in FEFO order across materials', () => {
  const engine = new KittingEngine({
    batches: [
      { batchId: 'B-A1', materialId: 'A', qty: 5, expiresAt: '2026-02-01' },
      { batchId: 'B-C1', materialId: 'C', qty: 4, expiresAt: '2026-01-15' },
      { batchId: 'B-C2', materialId: 'C', qty: 4, expiresAt: '2026-03-01' },
    ],
    substitutions: [{ material: 'A', substitute: 'C' }],
    orders: [{ orderId: 'O1', dueDate: '2026-04-01', lines: [{ materialId: 'A', qty: 8 }] }],
  });
  const report = engine.report();
  assert.equal(report.orders[0].status, 'OK');
  assert.deepEqual(reservationsOf(report, 'O1', 'L1'), [
    { batchId: 'B-C1', qty: 4 },
    { batchId: 'B-A1', qty: 4 },
  ]);
});

test('reservation order follows dueDate, then orderId, then line number', () => {
  const engine = new KittingEngine({
    batches: [{ batchId: 'B1', materialId: 'A', qty: 3, expiresAt: '2026-01-01' }],
    orders: [
      { orderId: 'O2', dueDate: '2026-02-02', lines: [{ materialId: 'A', qty: 2 }] },
      { orderId: 'O1', dueDate: '2026-02-01', lines: [{ materialId: 'A', qty: 2 }] },
    ],
  });
  const report = engine.report();
  const o1 = report.orders.find((o) => o.orderId === 'O1');
  const o2 = report.orders.find((o) => o.orderId === 'O2');
  assert.equal(o1.status, 'OK');
  assert.deepEqual(o1.lines[0].reservations, [{ batchId: 'B1', qty: 2 }]);
  assert.equal(o2.status, 'SHORT');
  assert.equal(o2.lines[0].reservedQty, 1);
  assert.equal(o2.lines[0].missing, 1);
});

test('holding a batch shifts reservations within the line before going SHORT', () => {
  const engine = new KittingEngine({
    batches: [
      { batchId: 'A1', materialId: 'A', qty: 3, expiresAt: '2026-01-01' },
      { batchId: 'A2', materialId: 'A', qty: 3, expiresAt: '2026-02-01' },
    ],
    orders: [{ orderId: 'O1', dueDate: '2026-03-01', lines: [{ materialId: 'A', qty: 5 }] }],
  });
  let report = engine.report();
  assert.equal(report.orders[0].status, 'OK');
  assert.deepEqual(reservationsOf(report, 'O1', 'L1'), [
    { batchId: 'A1', qty: 3 },
    { batchId: 'A2', qty: 2 },
  ]);

  engine.applyCommand({ op: 'holdBatch', batchId: 'A1' });
  report = engine.report();
  assert.equal(report.orders[0].status, 'SHORT');
  assert.deepEqual(reservationsOf(report, 'O1', 'L1'), [{ batchId: 'A2', qty: 3 }]);
  assert.deepEqual(report.orders[0].shortages, [
    {
      lineId: 'L1',
      materialId: 'A',
      required: 5,
      reservedQty: 3,
      missing: 2,
      substitutesTried: [],
    },
  ]);
});

test('shortage certificate lists substitutes that were tried', () => {
  const engine = new KittingEngine({
    batches: [
      { batchId: 'A1', materialId: 'A', qty: 1, expiresAt: '2026-01-01' },
      { batchId: 'C1', materialId: 'C', qty: 10, expiresAt: '2026-01-01', status: 'HOLD' },
    ],
    substitutions: [
      { material: 'A', substitute: 'B' },
      { material: 'B', substitute: 'C' },
    ],
    orders: [{ orderId: 'O1', dueDate: '2026-03-01', lines: [{ materialId: 'A', qty: 4 }] }],
  });
  const report = engine.report();
  assert.equal(report.orders[0].status, 'SHORT');
  assert.deepEqual(report.orders[0].shortages[0].substitutesTried, ['B', 'C']);
  assert.equal(report.orders[0].shortages[0].missing, 3);
});

test('freezing stock rearranges later orders without preempting earlier ones', () => {
  const engine = new KittingEngine({
    batches: [
      { batchId: 'X1', materialId: 'A', qty: 1, expiresAt: '2026-01-01' },
      { batchId: 'X2', materialId: 'A', qty: 1, expiresAt: '2026-02-01' },
    ],
    orders: [
      { orderId: 'O1', dueDate: '2026-03-01', lines: [{ materialId: 'A', qty: 1 }] },
      { orderId: 'O2', dueDate: '2026-03-02', lines: [{ materialId: 'A', qty: 1 }] },
    ],
  });
  let report = engine.report();
  assert.deepEqual(reservationsOf(report, 'O1', 'L1'), [{ batchId: 'X1', qty: 1 }]);
  assert.deepEqual(reservationsOf(report, 'O2', 'L1'), [{ batchId: 'X2', qty: 1 }]);

  engine.applyCommand({ op: 'holdBatch', batchId: 'X1' });
  report = engine.report();
  const o1 = report.orders.find((o) => o.orderId === 'O1');
  const o2 = report.orders.find((o) => o.orderId === 'O2');
  assert.equal(o1.status, 'OK');
  assert.deepEqual(o1.lines[0].reservations, [{ batchId: 'X2', qty: 1 }]);
  assert.equal(o2.status, 'SHORT');
  assert.equal(o2.lines[0].missing, 1);
});

test('order add/remove and batch release propagate incrementally', () => {
  const engine = new KittingEngine({
    batches: [{ batchId: 'B1', materialId: 'A', qty: 2, expiresAt: '2026-01-01' }],
    orders: [{ orderId: 'O1', dueDate: '2026-03-01', lines: [{ materialId: 'A', qty: 2 }] }],
  });
  engine.applyCommand({
    op: 'addOrder',
    order: { orderId: 'O2', dueDate: '2026-03-02', lines: [{ materialId: 'A', qty: 1 }] },
  });
  let report = engine.report();
  assert.equal(report.orders.find((o) => o.orderId === 'O2').status, 'SHORT');

  engine.applyCommand({ op: 'removeOrder', orderId: 'O1' });
  report = engine.report();
  assert.equal(report.orders.length, 1);
  assert.equal(report.orders[0].status, 'OK');

  engine.applyCommand({ op: 'holdBatch', batchId: 'B1' });
  assert.equal(engine.report().orders[0].status, 'SHORT');
  engine.applyCommand({ op: 'releaseBatch', batchId: 'B1' });
  assert.equal(engine.report().orders[0].status, 'OK');
});

test('removing a substitution invalidates dependent reservations', () => {
  const engine = new KittingEngine({
    batches: [{ batchId: 'C1', materialId: 'C', qty: 2, expiresAt: '2026-01-01' }],
    substitutions: [{ material: 'A', substitute: 'C' }],
    orders: [{ orderId: 'O1', dueDate: '2026-03-01', lines: [{ materialId: 'A', qty: 2 }] }],
  });
  assert.equal(engine.report().orders[0].status, 'OK');
  engine.applyCommand({ op: 'removeSubstitution', material: 'A', substitute: 'C' });
  const report = engine.report();
  assert.equal(report.orders[0].status, 'SHORT');
  assert.equal(report.orders[0].lines[0].reservedQty, 0);
  assert.deepEqual(report.orders[0].shortages[0].substitutesTried, []);
});

test('transitive substitution chains are honored', () => {
  const engine = new KittingEngine({
    batches: [{ batchId: 'D1', materialId: 'D', qty: 1, expiresAt: '2026-01-01' }],
    substitutions: [
      { material: 'A', substitute: 'B' },
      { material: 'B', substitute: 'D' },
    ],
    orders: [{ orderId: 'O1', dueDate: '2026-03-01', lines: [{ materialId: 'A', qty: 1 }] }],
  });
  const report = engine.report();
  assert.equal(report.orders[0].status, 'OK');
  assert.deepEqual(reservationsOf(report, 'O1', 'L1'), [{ batchId: 'D1', qty: 1 }]);
});

test('substitution cycle is rejected and state stays unchanged', () => {
  const engine = new KittingEngine({
    batches: [{ batchId: 'B1', materialId: 'A', qty: 1, expiresAt: '2026-01-01' }],
    substitutions: [
      { material: 'A', substitute: 'B' },
      { material: 'B', substitute: 'C' },
    ],
    orders: [],
  });
  const before = engine.report();
  assert.throws(
    () => engine.applyCommand({ op: 'addSubstitution', material: 'C', substitute: 'A' }),
    (error) => error instanceof KittingError && error.code === 'CYCLE',
  );
  assert.throws(
    () => engine.applyCommand({ op: 'addSubstitution', material: 'A', substitute: 'A' }),
    (error) => error.code === 'CYCLE',
  );
  assert.deepEqual(engine.report(), before);
});

test('over-consumption of a batch is rejected', () => {
  const engine = new KittingEngine({
    batches: [{ batchId: 'B1', materialId: 'A', qty: 2, expiresAt: '2026-01-01' }],
    orders: [],
  });
  assert.throws(
    () => engine.applyCommand({ op: 'consumeBatch', batchId: 'B1', qty: 3 }),
    (error) => error.code === 'OVER_CONSUME',
  );
  engine.applyCommand({ op: 'consumeBatch', batchId: 'B1', qty: 2 });
  assert.equal(engine.report().batches[0].qty, 0);
});

test('unknown batch, order and command are rejected', () => {
  const engine = new KittingEngine({ batches: [], orders: [] });
  assert.throws(
    () => engine.applyCommand({ op: 'holdBatch', batchId: 'NOPE' }),
    (error) => error.code === 'UNKNOWN_BATCH',
  );
  assert.throws(
    () => engine.applyCommand({ op: 'releaseBatch', batchId: 'NOPE' }),
    (error) => error.code === 'UNKNOWN_BATCH',
  );
  assert.throws(
    () => engine.applyCommand({ op: 'removeOrder', orderId: 'NOPE' }),
    (error) => error.code === 'UNKNOWN_ORDER',
  );
  assert.throws(
    () => engine.applyCommand({ op: 'teleport' }),
    (error) => error.code === 'UNKNOWN_COMMAND',
  );
});

test('duplicate ids and invalid payloads are rejected', () => {
  assert.throws(
    () =>
      new KittingEngine({
        batches: [
          { batchId: 'B1', materialId: 'A', qty: 1, expiresAt: '2026-01-01' },
          { batchId: 'B1', materialId: 'A', qty: 1, expiresAt: '2026-01-02' },
        ],
      }),
    (error) => error.code === 'DUPLICATE_BATCH',
  );
  assert.throws(
    () =>
      new KittingEngine({
        batches: [{ batchId: 'B1', materialId: 'A', qty: -1, expiresAt: '2026-01-01' }],
      }),
    (error) => error.code === 'VALIDATION',
  );
  const engine = new KittingEngine({
    orders: [{ orderId: 'O1', dueDate: '2026-03-01', lines: [{ materialId: 'A', qty: 1 }] }],
  });
  assert.throws(
    () =>
      engine.applyCommand({
        op: 'addOrder',
        order: { orderId: 'O1', dueDate: '2026-04-01', lines: [{ materialId: 'A', qty: 1 }] },
      }),
    (error) => error.code === 'DUPLICATE_ORDER',
  );
});

test('undo and redo restore state across mutations', () => {
  const engine = new KittingEngine({
    batches: [{ batchId: 'B1', materialId: 'A', qty: 1, expiresAt: '2026-01-01' }],
    orders: [],
  });
  const initial = engine.report();
  engine.applyCommand({
    op: 'addOrder',
    order: { orderId: 'O1', dueDate: '2026-03-01', lines: [{ materialId: 'A', qty: 1 }] },
  });
  engine.applyCommand({ op: 'holdBatch', batchId: 'B1' });
  assert.equal(engine.report().orders[0].status, 'SHORT');

  engine.applyCommand({ op: 'undo' });
  assert.equal(engine.report().orders[0].status, 'OK');
  engine.applyCommand({ op: 'undo' });
  assert.deepEqual(engine.report(), initial);
  assert.throws(() => engine.applyCommand({ op: 'undo' }), (error) => error.code === 'EMPTY_UNDO');

  engine.applyCommand({ op: 'redo' });
  engine.applyCommand({ op: 'redo' });
  assert.equal(engine.report().orders[0].status, 'SHORT');
  assert.throws(() => engine.applyCommand({ op: 'redo' }), (error) => error.code === 'EMPTY_REDO');

  engine.applyCommand({ op: 'undo' });
  engine.applyCommand({ op: 'releaseBatch', batchId: 'B1' });
  assert.throws(() => engine.applyCommand({ op: 'redo' }), (error) => error.code === 'EMPTY_REDO');
});
