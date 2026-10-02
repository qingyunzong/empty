import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInstance } from '../src/model.js';
import { solve, replaceOperation } from '../src/solver.js';

const rawInstance = {
  machines: ['M1', 'M2'],
  tools: [
    { id: 'T1', life: 100 },
    { id: 'T2', life: 100 },
  ],
  fixtures: ['F1'],
  horizon: 12,
  slotMinutes: 10,
  dueSlot: 12,
  operations: [
    { id: 'op1', machines: ['M1'], minutes: 30, fixture: 'F1', tools: ['T1'] },
    { id: 'op2', machines: ['M2'], minutes: 40, fixture: 'F1', tools: ['T1', 'T2'] },
    { id: 'op3', machines: ['M1', 'M2'], minutes: 20, tools: ['T1'] },
  ],
};

function expectedToolLoads(instance, assignments) {
  const loads = Object.fromEntries(instance.tools.map((t) => [t.id, 0]));
  for (const op of instance.operations) {
    const a = assignments[op.id];
    if (a) loads[a.tool] += op.minutes;
  }
  return loads;
}

// Acceptance 3: after replacement, old propagation is fully revoked and
// shared-tool cumulative loads are correct; other assignments stay fixed.
test('replace rolls back old op and keeps other assignments', () => {
  const instance = parseInstance(rawInstance);
  const scheduled = solve(instance);
  assert.equal(scheduled.status, 'optimal');
  const before = scheduled.assignments;

  const newOp = {
    id: 'op1b',
    machines: ['M1', 'M2'],
    minutes: 50,
    fixture: 'F1',
    tools: ['T2'],
  };
  const result = replaceOperation(instance, before, 'op1', newOp);
  assert.equal(result.status, 'optimal');
  assert.equal(result.rolledBack, 'op1');

  // Other committed assignments are unchanged.
  assert.deepEqual(result.assignments.op2, before.op2);
  assert.deepEqual(result.assignments.op3, before.op3);
  // Old op is gone, new op is assigned.
  assert.equal(result.assignments.op1, undefined);
  assert.ok(result.assignments.op1b);
  assert.equal(result.assignments.op1b.tool, 'T2');

  // Shared-tool cumulative values are exactly the sum over remaining ops.
  const newInstance = parseInstance({
    ...rawInstance,
    operations: [...rawInstance.operations.filter((o) => o.id !== 'op1'), newOp],
  });
  assert.deepEqual(result.toolLoad, expectedToolLoads(newInstance, result.assignments));
  // T1 no longer carries op1's 30 minutes.
  assert.equal(result.toolLoad.T1, (before.op2.tool === 'T1' ? 40 : 0) + 20);
});

test('replace verifies old constraints are fully revoked (state reusable)', () => {
  const instance = parseInstance(rawInstance);
  const scheduled = solve(instance);
  const before = scheduled.assignments;

  // Replace op2 with an op that reuses op1's exact machine/slot/fixture would
  // conflict; instead replace op1 with an op placed where op1 used to be is
  // fine only after rollback. We replace op1 with an identical op and expect
  // the same assignment to still be feasible (i.e. rollback freed the slots).
  const sameOp = { ...rawInstance.operations[0], id: 'op1c' };
  const result = replaceOperation(instance, before, 'op1', sameOp);
  assert.equal(result.status, 'optimal');
  // Fixture F1 occupancy from op1 was revoked: the new op can occupy the
  // exact same machine/fixture/slot window again.
  assert.deepEqual(result.assignments.op1c, before.op1);
});

test('replace with over-life tool demand returns tool-life proof', () => {
  const instance = parseInstance(rawInstance);
  const scheduled = solve(instance);
  const result = replaceOperation(instance, scheduled.assignments, 'op1', {
    id: 'op1x',
    machines: ['M1'],
    minutes: 90,
    tools: ['T1'],
  });
  assert.equal(result.status, 'infeasible');
  assert.equal(result.proof.type, 'tool-life');
  const t1 = result.proof.tools.find((t) => t.tool === 'T1');
  assert.ok(t1, 'proof names the over-limit tool T1');
  assert.ok(t1.currentLoad + t1.addedMinutes > t1.life);
});

test('replace rejects unknown operation and unknown tool', () => {
  const instance = parseInstance(rawInstance);
  const scheduled = solve(instance);
  assert.throws(
    () => replaceOperation(instance, scheduled.assignments, 'nope', { id: 'x' }),
    /unknown operation/
  );
  assert.throws(
    () =>
      replaceOperation(instance, scheduled.assignments, 'op1', {
        id: 'op1y',
        machines: ['M1'],
        minutes: 10,
        tools: ['T9'],
      }),
    /unknown tool "T9"/
  );
});
