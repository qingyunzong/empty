import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schedule } from '../src/scheduler.js';

const STATIONS = ['DIAG', 'REP', 'INSP'];

function makeInput(overrides = {}) {
  return {
    shifts: 2,
    lines: [{ id: 'L1', budgetPerShift: 480 }],
    stations: STATIONS.map((id) => ({ id, lineId: 'L1', capacityPerShift: 240 })),
    orders: [],
    ...overrides,
  };
}

function route(minutes = [60, 120, 30]) {
  return STATIONS.map((station, i) => ({ station, minutes: minutes[i] }));
}

test('atomic allocation: all three levels succeed', () => {
  const input = makeInput({
    orders: [{ id: 'WO-1', priority: 'normal', arrivalShift: 0, route: route() }],
  });
  const result = schedule(input);

  assert.equal(result.errors.length, 0);
  assert.equal(result.routes.length, 1);
  assert.deepEqual(result.routes[0].steps.map((s) => s.station), STATIONS);
  assert.deepEqual(result.routes[0].steps.map((s) => s.shift), [0, 0, 0]);
  assert.equal(result.waiting.length, 0);
  assert.equal(result.rollbacks.length, 0);
  assert.equal(result.preemptions.length, 0);

  // Per-level budget deductions on the line.
  assert.equal(result.budgetDeductions.length, 3);
  assert.deepEqual(
    result.budgetDeductions.map((d) => [d.stepIndex, d.lineId, d.shift, d.minutes]),
    [[0, 'L1', 0, 60], [1, 'L1', 0, 120], [2, 'L1', 0, 30]],
  );
  assert.equal(result.lineUsage.L1[0], 210);
  assert.equal(result.stationUsage.DIAG[0], 60);
  assert.equal(result.stationUsage.REP[0], 120);
  assert.equal(result.stationUsage.INSP[0], 30);
});

test('level-2 failure rolls back the level-1 tentative hold exactly', () => {
  const input = makeInput({
    shifts: 1,
    orders: [{ id: 'WO-1', priority: 'normal', arrivalShift: 0, route: route() }],
  });
  input.stations.find((s) => s.id === 'REP').capacityPerShift = [0];

  const result = schedule(input);

  assert.equal(result.routes.length, 0);
  assert.deepEqual(result.waiting, ['WO-1']);
  assert.equal(result.rollbacks.length, 1);
  const rollback = result.rollbacks[0];
  assert.equal(rollback.orderId, 'WO-1');
  assert.equal(rollback.reason, 'atomic-rollback');
  assert.equal(rollback.failedStep, 1);
  assert.equal(rollback.station, 'REP');
  assert.deepEqual(
    rollback.released.map((p) => [p.station, p.shift, p.minutes]),
    [['DIAG', 0, 60]],
  );
  // No half-finished locks remain anywhere.
  assert.deepEqual(result.stationUsage.DIAG, [0]);
  assert.deepEqual(result.stationUsage.REP, [0]);
  assert.deepEqual(result.stationUsage.INSP, [0]);
  assert.deepEqual(result.lineUsage.L1, [0]);
  assert.equal(result.budgetDeductions.length, 0);
});

test('level-3 failure rolls back levels 1 and 2 exactly', () => {
  const input = makeInput({
    shifts: 1,
    orders: [{ id: 'WO-1', priority: 'normal', arrivalShift: 0, route: route() }],
  });
  input.stations.find((s) => s.id === 'INSP').capacityPerShift = [0];

  const result = schedule(input);

  assert.equal(result.routes.length, 0);
  assert.deepEqual(result.waiting, ['WO-1']);
  assert.equal(result.rollbacks.length, 1);
  const rollback = result.rollbacks[0];
  assert.equal(rollback.reason, 'atomic-rollback');
  assert.equal(rollback.failedStep, 2);
  assert.deepEqual(
    rollback.released.map((p) => [p.station, p.shift, p.minutes]),
    [['DIAG', 0, 60], ['REP', 0, 120]],
  );
  assert.deepEqual(result.lineUsage.L1, [0]);
  for (const id of STATIONS) assert.deepEqual(result.stationUsage[id], [0]);
});

test('insufficient shift budget triggers rollback, not a partial lock', () => {
  const input = makeInput({
    shifts: 1,
    lines: [{ id: 'L1', budgetPerShift: 150 }],
    orders: [{ id: 'WO-1', priority: 'normal', arrivalShift: 0, route: route([60, 120, 30]) }],
  });

  const result = schedule(input);

  assert.equal(result.errors.length, 0); // each step individually fits the budget
  assert.equal(result.routes.length, 0);
  assert.equal(result.rollbacks.length, 1);
  assert.equal(result.rollbacks[0].reason, 'atomic-rollback');
  assert.equal(result.rollbacks[0].failedStep, 1);
  assert.deepEqual(
    result.rollbacks[0].released.map((p) => [p.station, p.minutes]),
    [['DIAG', 60]],
  );
  assert.deepEqual(result.lineUsage.L1, [0]);
});

test('high-priority preempts a full contiguous segment; aged normal is rescheduled', () => {
  // Capacity exists only at shifts 2 and 3, one order per shift.
  const input = makeInput({
    shifts: 4,
    lines: [{ id: 'L1', budgetPerShift: 1000 }],
    stations: STATIONS.map((id) => ({ id, lineId: 'L1', capacityPerShift: [0, 0, 50, 50] })),
    orders: [
      { id: 'WO-Z-old', priority: 'normal', arrivalShift: 0, route: route([50, 50, 50]) },
      { id: 'WO-A-young', priority: 'normal', arrivalShift: 1, route: route([50, 50, 50]) },
      { id: 'WO-H', priority: 'high', arrivalShift: 2, route: route([50, 50, 50]) },
    ],
  });

  const result = schedule(input);

  assert.equal(result.errors.length, 0);
  assert.equal(result.preemptions.length, 1);
  const preemption = result.preemptions[0];
  assert.equal(preemption.orderId, 'WO-H');
  assert.deepEqual(preemption.stations, STATIONS); // complete contiguous segment
  assert.deepEqual(preemption.evicted, ['WO-A-young']);
  assert.deepEqual(preemption.rescheduled, ['WO-Z-old']);

  // Both normals rolled back out of the preemptor's way.
  const preemptedRollbacks = result.rollbacks.filter((r) => r.reason === 'preempted');
  assert.equal(preemptedRollbacks.length, 2);
  const oldRollback = preemptedRollbacks.find((r) => r.orderId === 'WO-Z-old');
  assert.deepEqual(oldRollback.released.map((p) => p.shift), [2, 2, 2]);

  // High-priority order takes the segment; aged normal is re-placed later.
  const byId = new Map(result.routes.map((r) => [r.orderId, r]));
  assert.deepEqual(byId.get('WO-H').steps.map((s) => s.shift), [2, 2, 2]);
  assert.deepEqual(byId.get('WO-Z-old').steps.map((s) => s.shift), [3, 3, 3]);

  // The younger normal (id sorts first, but aging lost) stays waiting.
  assert.deepEqual(result.waiting, ['WO-A-young']);

  // Final usage is consistent: shift 2 = WO-H, shift 3 = WO-Z-old.
  for (const id of STATIONS) {
    assert.deepEqual(result.stationUsage[id], [0, 0, 50, 50]);
  }
});

test('preemption is all-or-nothing: unsatisfiable segment preempts nothing', () => {
  const input = makeInput({
    shifts: 1,
    lines: [{ id: 'L1', budgetPerShift: 1000 }],
    stations: [
      { id: 'DIAG', lineId: 'L1', capacityPerShift: [50] },
      { id: 'REP', lineId: 'L1', capacityPerShift: [50] },
      { id: 'INSP', lineId: 'L1', capacityPerShift: [0] }, // level 3 can never run
    ],
    orders: [
      { id: 'WO-N', priority: 'normal', arrivalShift: 0, route: [{ station: 'DIAG', minutes: 50 }] },
      { id: 'WO-H', priority: 'high', arrivalShift: 0, route: route([50, 50, 50]) },
    ],
  });

  const result = schedule(input);

  assert.equal(result.preemptions.length, 0);
  assert.equal(result.rollbacks.filter((r) => r.reason === 'preempted').length, 0);
  // The normal order keeps its slot untouched.
  const normal = result.routes.find((r) => r.orderId === 'WO-N');
  assert.deepEqual(normal.steps.map((s) => [s.station, s.shift]), [['DIAG', 0]]);
  assert.deepEqual(result.waiting, ['WO-H']);
  assert.equal(result.stationUsage.DIAG[0], 50);
});

test('waiting queue is ordered by priority, then aging', () => {
  const input = makeInput({
    shifts: 1,
    lines: [{ id: 'L1', budgetPerShift: 1000 }],
    stations: STATIONS.map((id) => ({ id, lineId: 'L1', capacityPerShift: [0] })),
    orders: [
      { id: 'WO-c', priority: 'normal', arrivalShift: 0, route: route([10, 10, 10]) },
      { id: 'WO-a', priority: 'normal', arrivalShift: 0, route: route([10, 10, 10]) },
      { id: 'WO-b', priority: 'high', arrivalShift: 0, route: route([10, 10, 10]) },
    ],
  });

  const result = schedule(input);
  assert.deepEqual(result.waiting, ['WO-b', 'WO-a', 'WO-c']);
});

test('negative minutes, unknown station and over-budget are errors', () => {
  const input = makeInput({
    lines: [{ id: 'L1', budgetPerShift: 100 }],
    orders: [
      { id: 'WO-NEG', route: [{ station: 'DIAG', minutes: -5 }] },
      { id: 'WO-UNK', route: [{ station: 'NOPE', minutes: 10 }] },
      { id: 'WO-OVER', route: [{ station: 'DIAG', minutes: 999 }] },
      { id: 'WO-OK', route: [{ station: 'DIAG', minutes: 10 }] },
    ],
  });

  const result = schedule(input);

  const codes = new Map(result.errors.map((e) => [e.orderId, e.code]));
  assert.equal(codes.get('WO-NEG'), 'negative-minutes');
  assert.equal(codes.get('WO-UNK'), 'unknown-station');
  assert.equal(codes.get('WO-OVER'), 'over-budget');
  assert.equal(result.errors.length, 3);

  // Valid orders in the same input are still scheduled.
  assert.deepEqual(result.routes.map((r) => r.orderId), ['WO-OK']);
  assert.equal(result.lineUsage.L1[0], 10);
});
