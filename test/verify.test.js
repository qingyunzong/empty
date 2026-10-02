import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInput } from '../src/model.js';
import { schedule } from '../src/scheduler.js';
import { verifySchedule, enumerateAssignments, timingKey } from '../src/verify.js';

const STATIONS = ['DIAG', 'REP', 'INSP'];

function smallInput() {
  return {
    shifts: 3,
    lines: [{ id: 'L1', budgetPerShift: 200 }],
    stations: STATIONS.map((id) => ({ id, lineId: 'L1', capacityPerShift: 60 })),
    orders: [
      { id: 'WO-1', priority: 'normal', arrivalShift: 0, route: [
        { station: 'DIAG', minutes: 40 }, { station: 'REP', minutes: 40 }, { station: 'INSP', minutes: 40 }] },
      { id: 'WO-2', priority: 'normal', arrivalShift: 0, route: [
        { station: 'DIAG', minutes: 30 }, { station: 'REP', minutes: 50 }] },
    ],
  };
}

function scheduleKey(result, orderIds) {
  const byId = new Map(result.routes.map((r) => [r.orderId, timingKey(r.steps)]));
  return orderIds.map((id) => byId.get(id)).join('|');
}

function assignmentKey(assignment) {
  return assignment.map((vector) => vector.join(',')).join('|');
}

test('enumeration (<=4 orders): scheduler output is a feasible route timing', () => {
  const input = smallInput();
  const norm = normalizeInput(input);
  const result = schedule(input);

  assert.equal(result.routes.length, 2);
  assert.equal(result.waiting.length, 0);

  const verification = verifySchedule(norm, result);
  assert.deepEqual(verification, { ok: true, violations: [] });

  const orderIds = ['WO-1', 'WO-2'];
  const { assignments, truncated } = enumerateAssignments(norm, orderIds);
  assert.equal(truncated, false);
  assert.ok(assignments.length > 0);

  const keys = new Set(assignments.map(assignmentKey));
  assert.ok(
    keys.has(scheduleKey(result, orderIds)),
    'scheduler timing must be one of the enumerated feasible timings',
  );
});

test('enumeration confirms infeasibility when total demand exceeds capacity', () => {
  const input = {
    shifts: 3,
    lines: [{ id: 'L1', budgetPerShift: 500 }],
    stations: [
      { id: 'DIAG', lineId: 'L1', capacityPerShift: [0, 100, 0] },
      { id: 'REP', lineId: 'L1', capacityPerShift: [0, 100, 0] },
    ],
    orders: [
      { id: 'WO-1', priority: 'normal', arrivalShift: 0, route: [
        { station: 'DIAG', minutes: 80 }, { station: 'REP', minutes: 80 }] },
      { id: 'WO-2', priority: 'normal', arrivalShift: 0, route: [
        { station: 'DIAG', minutes: 80 }, { station: 'REP', minutes: 80 }] },
    ],
  };
  const norm = normalizeInput(input);
  const result = schedule(input);

  // Only one order can ever fit: enumeration finds no joint assignment.
  const { assignments } = enumerateAssignments(norm, ['WO-1', 'WO-2']);
  assert.equal(assignments.length, 0);
  assert.equal(result.routes.length, 1);
  assert.equal(result.waiting.length, 1);
  assert.ok(verifySchedule(norm, result).ok);
});

test('verifySchedule rejects tampered timings', () => {
  const input = smallInput();
  const norm = normalizeInput(input);
  const result = schedule(input);

  // Force every step of both orders into shift 0: exceeds the 60-minute capacity.
  const tampered = JSON.parse(JSON.stringify(result));
  for (const route of tampered.routes) {
    for (const step of route.steps) step.shift = 0;
  }
  const verification = verifySchedule(norm, tampered);
  assert.equal(verification.ok, false);
  assert.ok(verification.violations.some((v) => v.includes('capacity')));

  // Non-monotonic step order is rejected too.
  const reordered = JSON.parse(JSON.stringify(result));
  const steps = reordered.routes[0].steps;
  steps[0].shift = 2;
  steps[1].shift = 0;
  const orderCheck = verifySchedule(norm, reordered);
  assert.equal(orderCheck.ok, false);
  assert.ok(orderCheck.violations.some((v) => v.includes('invalid shift')));
});
