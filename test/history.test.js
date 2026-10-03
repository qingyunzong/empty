import test from 'node:test';
import assert from 'node:assert/strict';
import { Planner } from '../src/planner.js';
import { CODES } from '../src/errors.js';

function makePlanner() {
  return new Planner({
    calendar: {
      start: '2026-10-05T08:00:00Z',
      shifts: [{ days: [1], start: '08:00', end: '20:00' }],
    },
    machines: ['M1'],
  });
}

const O1 = { id: 'O1', operations: [{ id: 'a', machine: 'M1', cycleTime: 30 }] };
const O2 = { id: 'O2', operations: [{ id: 'b', machine: 'M1', cycleTime: 30 }] };

test('undo/redo operate on command groups atomically', () => {
  const p = makePlanner();
  p.beginGroup('setup');
  p.addOrder(O1);
  p.addOrder(O2);
  p.commitGroup();
  assert.equal(p.orders.size, 2);
  assert.equal(p.history.length, 1, 'two commands inside one group form a single history entry');

  assert.equal(p.schedule().ok, true);
  assert.equal(p.planJson().orders.length, 2);
  assert.equal(p.history.length, 2);

  assert.equal(p.undo().ok, true);
  assert.equal(p.planJson().orders.length, 0, 'undo of schedule clears the plan');
  assert.equal(p.orders.size, 2, 'orders survive undo of schedule');

  assert.equal(p.undo().ok, true);
  assert.equal(p.orders.size, 0, 'undo of the group removes both orders at once');

  assert.equal(p.redo().ok, true);
  assert.equal(p.orders.size, 2);
  assert.equal(p.redo().ok, true);
  assert.equal(p.planJson().orders.length, 2);

  assert.equal(p.redo().ok, false);
  assert.equal(p.redo().code, CODES.INVALID_STATE);
});

test('commands outside a group are individually undoable', () => {
  const p = makePlanner();
  p.addOrder(O1);
  p.addOrder(O2);
  assert.equal(p.history.length, 2);
  p.undo();
  assert.deepEqual([...p.orders.keys()], ['O1']);
  p.undo();
  assert.equal(p.orders.size, 0);
  assert.equal(p.undo().ok, false);
});

test('new commands clear the redo stack', () => {
  const p = makePlanner();
  p.addOrder(O1);
  p.undo();
  p.addOrder(O2);
  assert.equal(p.redo().ok, false);
  assert.deepEqual([...p.orders.keys()], ['O2']);
});

test('failed rush reschedule creates no history entry', () => {
  const p = new Planner({
    calendar: {
      start: '2026-10-05T08:00:00Z',
      shifts: [{ days: [1], start: '08:00', end: '11:00' }],
    },
    machines: ['M1'],
  });
  p.addOrder({
    id: 'A',
    due: '2026-10-05T09:00:00Z',
    deadline: '2026-10-05T10:00:00Z',
    operations: [{ id: 'a1', machine: 'M1', cycleTime: 60 }],
  });
  p.addOrder({
    id: 'B',
    due: '2026-10-05T10:00:00Z',
    deadline: '2026-10-05T11:00:00Z',
    operations: [{ id: 'b1', machine: 'M1', cycleTime: 60 }],
  });
  p.schedule();
  const depth = p.history.length;
  const r = p.insertRush(
    {
      id: 'R',
      release: '2026-10-05T08:00:00Z',
      due: '2026-10-05T08:30:00Z',
      deadline: '2026-10-05T09:00:00Z',
      operations: [{ id: 'r1', machine: 'M1', cycleTime: 60 }],
    },
    { budget: 1 },
  );
  assert.equal(r.ok, false);
  assert.equal(p.history.length, depth, 'no history entry on failure');
});
