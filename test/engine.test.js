'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEngine, moldCfg, MON, TUE } = require('./helpers');

test('move picks the plan with fewest adjustments', () => {
  const { engine } = makeEngine();
  engine.execute({ cmd: 'addMold', mold: moldCfg({ id: 'MA', cycleMinutes: 1000 }) });
  engine.execute({ cmd: 'addMold', mold: moldCfg({ id: 'MB', cycleMinutes: 1000 }) });
  engine.execute({ cmd: 'book', order: { id: 'A1', minutes: 60, moldId: 'MA' } });
  engine.execute({ cmd: 'book', order: { id: 'A2', minutes: 60, moldId: 'MA' } });
  engine.execute({ cmd: 'book', order: { id: 'A3', minutes: 60, moldId: 'MA' } });

  // moving A3 to empty MB disturbs no other order; inserting it at the
  // front of MA would shift A1/A2 (2 adjustments)
  const res = engine.execute({ cmd: 'move', orderId: 'A3' });
  assert.equal(res.plan.mold, 'MB');
  assert.equal(res.adjustments, 0);
  assert.equal(res.start, `${MON}T08:00:00.000Z`);
  assert.deepEqual(engine.state.queues.MA, ['A1', 'A2']);
  assert.deepEqual(engine.state.queues.MB, ['A3']);
});

test('move tie: earliest completion, then smallest mold id', () => {
  const { engine } = makeEngine();
  engine.execute({ cmd: 'addMold', mold: moldCfg({ id: 'MC', cycleMinutes: 1000 }) });
  engine.execute({ cmd: 'addMold', mold: moldCfg({ id: 'MB', cycleMinutes: 1000 }) });
  engine.execute({ cmd: 'addMold', mold: moldCfg({ id: 'MA', cycleMinutes: 1000 }) });
  engine.execute({ cmd: 'book', order: { id: 'X1', minutes: 60, moldId: 'MC' } });
  engine.execute({ cmd: 'book', order: { id: 'X2', minutes: 60, moldId: 'MC' } });

  // X2 can move to MA or MB: both 0 adjustments, same completion -> MA wins
  const res = engine.execute({ cmd: 'move', orderId: 'X2' });
  assert.equal(res.plan.mold, 'MA');
  assert.equal(res.adjustments, 0);
});

test('move with explicit mold and index', () => {
  const { engine } = makeEngine();
  engine.execute({ cmd: 'addMold', mold: moldCfg({ id: 'MA', cycleMinutes: 1000 }) });
  engine.execute({ cmd: 'book', order: { id: 'A1', minutes: 60, moldId: 'MA' } });
  engine.execute({ cmd: 'book', order: { id: 'A2', minutes: 60, moldId: 'MA' } });
  engine.execute({ cmd: 'book', order: { id: 'A3', minutes: 60, moldId: 'MA' } });
  const res = engine.execute({ cmd: 'move', orderId: 'A3', moldId: 'MA', index: 0 });
  assert.equal(res.plan.index, 0);
  assert.equal(res.adjustments, 2); // A1 and A2 shifted later
  assert.deepEqual(engine.state.queues.MA, ['A3', 'A1', 'A2']);
});

test('cancel frees occupancy and pulls later orders earlier', () => {
  const { engine } = makeEngine();
  engine.execute({ cmd: 'addMold', mold: moldCfg({ id: 'MA', cycleMinutes: 1000 }) });
  engine.execute({ cmd: 'book', order: { id: 'A1', minutes: 60, moldId: 'MA' } });
  engine.execute({ cmd: 'book', order: { id: 'A2', minutes: 60, moldId: 'MA' } });
  engine.execute({ cmd: 'cancel', orderId: 'A1' });
  const state = engine.execute({ cmd: 'state' });
  assert.deepEqual(state.molds.MA.queue, ['A2']);
  const a2 = state.molds.MA.schedule.find((i) => i.orderId === 'A2');
  assert.equal(a2.start, `${MON}T08:00:00.000Z`);
});

test('correct adjusts duration incrementally and reschedules', () => {
  const { engine } = makeEngine();
  engine.execute({ cmd: 'addMold', mold: moldCfg({ id: 'MA', cycleMinutes: 1000 }) });
  engine.execute({ cmd: 'book', order: { id: 'A1', minutes: 60, moldId: 'MA' } });
  engine.execute({ cmd: 'book', order: { id: 'A2', minutes: 60, moldId: 'MA' } });
  const res = engine.execute({ cmd: 'correct', orderId: 'A1', deltaMinutes: 30 });
  assert.equal(res.minutes, 90);
  assert.equal(res.end, `${MON}T09:30:00.000Z`);
  const state = engine.execute({ cmd: 'state' });
  const a2 = state.molds.MA.schedule.find((i) => i.orderId === 'A2');
  assert.equal(a2.start, `${MON}T09:30:00.000Z`);
  assert.throws(() => engine.execute({ cmd: 'correct', orderId: 'A1', deltaMinutes: -1000 }), /must be > 0/);
});

test('undo restores life and occupancy per work-order transaction', () => {
  const { engine } = makeEngine();
  engine.execute({ cmd: 'addMold', mold: moldCfg({ id: 'MA', cycleMinutes: 100, maintenanceMinutes: 20 }) });
  engine.execute({ cmd: 'book', order: { id: 'A1', minutes: 90, moldId: 'MA' } });
  const bookTx = engine.execute({ cmd: 'book', order: { id: 'A2', minutes: 90, moldId: 'MA' } });
  // A2 forced a maintenance; undoing its transaction must remove both
  let state = engine.execute({ cmd: 'state' });
  assert.equal(state.molds.MA.schedule.filter((i) => i.type === 'maintenance').length, 1);
  assert.equal(state.molds.MA.derivedUsedMinutes, 90);

  const undone = engine.execute({ cmd: 'undo', txId: bookTx.txId });
  assert.equal(undone.undone, bookTx.txId);
  state = engine.execute({ cmd: 'state' });
  assert.deepEqual(state.molds.MA.queue, ['A1']);
  assert.equal(state.molds.MA.schedule.filter((i) => i.type === 'maintenance').length, 0);
  assert.equal(state.molds.MA.derivedUsedMinutes, 90); // life restored
  assert.deepEqual(state.journal, ['tx1', 'tx2']);
});

test('undo without txId reverts the latest transaction', () => {
  const { engine } = makeEngine();
  engine.execute({ cmd: 'addMold', mold: moldCfg({ id: 'MA', cycleMinutes: 1000 }) });
  engine.execute({ cmd: 'book', order: { id: 'A1', minutes: 60, moldId: 'MA' } });
  engine.execute({ cmd: 'undo' });
  assert.deepEqual(engine.state.queues.MA, []);
  assert.throws(() => engine.execute({ cmd: 'undo', txId: 'nope' }), /nothing to undo/);
});

test('forced reset interval blocks production and resets the life counter', () => {
  const { engine } = makeEngine();
  engine.execute({
    cmd: 'addMold',
    mold: moldCfg({
      id: 'MA',
      cycleMinutes: 100,
      maintenanceMinutes: 20,
      resetIntervals: [[`${MON}T12:00:00Z`, `${MON}T13:00:00Z`]],
    }),
  });
  engine.execute({ cmd: 'book', order: { id: 'A1', minutes: 80, moldId: 'MA' } });
  // A2 starts after the reset (notBefore), so no maintenance is needed
  engine.execute({ cmd: 'book', order: { id: 'A2', minutes: 80, moldId: 'MA', notBefore: `${MON}T13:00:00Z` } });
  const state = engine.execute({ cmd: 'state' });
  const items = state.molds.MA.schedule;
  assert.equal(items.filter((i) => i.type === 'maintenance').length, 0);
  const a2 = items.find((i) => i.orderId === 'A2');
  assert.equal(a2.start, `${MON}T13:00:00.000Z`);
  assert.equal(state.molds.MA.derivedUsedMinutes, 80);
});

test('book without moldId picks earliest completion then mold id', () => {
  const { engine } = makeEngine();
  engine.execute({ cmd: 'addMold', mold: moldCfg({ id: 'MB', cycleMinutes: 1000 }) });
  engine.execute({ cmd: 'addMold', mold: moldCfg({ id: 'MA', cycleMinutes: 1000 }) });
  engine.execute({ cmd: 'book', order: { id: 'A1', minutes: 120, moldId: 'MA' } });
  // MB is free all morning, MA busy 08:00-10:00 -> MB finishes earlier
  const r1 = engine.execute({ cmd: 'book', order: { id: 'A2', minutes: 120 } });
  assert.equal(r1.mold, 'MB');
  // now both busy until 10:00 -> tie on completion -> smaller id MA
  const r2 = engine.execute({ cmd: 'book', order: { id: 'A3', minutes: 60 } });
  assert.equal(r2.mold, 'MA');
});

test('validation errors', () => {
  const { engine } = makeEngine();
  assert.throws(() => engine.execute({ cmd: 'bogus' }), /unknown command/);
  assert.throws(() => engine.execute({ cmd: 'book', order: { id: 'X', minutes: 10 } }), /no molds/);
  engine.execute({ cmd: 'addMold', mold: moldCfg({ id: 'MA', cycleMinutes: 100 }) });
  assert.throws(() => engine.execute({ cmd: 'addMold', mold: moldCfg({ id: 'MA', cycleMinutes: 100 }) }), /already exists/);
  assert.throws(() => engine.execute({ cmd: 'cancel', orderId: 'ghost' }), /unknown order/);
});
