import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlan, updatePlan } from '../src/planner.js';

const CONFIG = {
  capacity: 10,
  runDuration: 60,
  cleanoutTime: 30,
  dayLength: 480,
  slotDuration: 15,
  compensationSlots: 2,
};

test('urgent order preempts at batch boundary; remainder continues afterwards', (t) => {
  const scenario = {
    config: CONFIG,
    recipes: [{ id: 'A', family: 'F1', dailyQuota: 100 }],
    orders: [
      { id: 'n1', recipe: 'A', qty: 15, due: 1000 },
      { id: 'n2', recipe: 'A', qty: 10, due: 1000 },
    ],
  };
  const plan1 = createPlan(scenario);
  assert.equal(plan1.status, 'ok');
  assert.equal(plan1.runs.length, 3);
  // run1: n1x10 (0-60), run2: n1x5+n2x5 (60-120), run3: n2x5 (120-180)
  assert.deepEqual(plan1.runs[0].loads, [{ orderId: 'n1', recipe: 'A', qty: 10 }]);

  const plan2 = updatePlan(plan1, {
    freezeTime: 60,
    addOrders: [{ id: 'u1', recipe: 'A', qty: 10, due: 70, priority: 'urgent' }],
  });
  assert.equal(plan2.status, 'ok', plan2.reasons.join('; '));

  // Frozen history is untouched.
  assert.deepEqual(plan2.runs[0], plan1.runs[0]);
  assert.deepEqual(plan2.freezeBoundary, { freezeTime: 60, frozenRunIds: [1] });

  // Urgent batch takes the first free boundary right after the frozen run.
  assert.equal(plan2.runs[1].start, 60);
  assert.deepEqual(plan2.runs[1].loads, [{ orderId: 'u1', recipe: 'A', qty: 10 }]);

  // Unloaded remainder of the preempted normal batch goes back to the queue
  // and is continued in a later run.
  const n1Remainder = plan2.runs[2].loads.find((l) => l.orderId === 'n1');
  assert.deepEqual(n1Remainder, { orderId: 'n1', recipe: 'A', qty: 5 });
  assert.ok(plan2.runs[2].start >= plan2.runs[1].end);

  // Incremental diff: old unfrozen runs replaced by new ones.
  assert.deepEqual(plan2.diff.removedRunIds, [2, 3]);
  assert.deepEqual(plan2.diff.addedRunIds, [4, 5, 6]);
  assert.deepEqual(plan2.diff.canceledOrderIds, []);

  t.diagnostic(`preemption diff: ${JSON.stringify(plan2.diff)} objective=${JSON.stringify(plan2.objective)}`);
});

test('cancel of tooling-prepared order adds compensation, releases quota, keeps frozen history', (t) => {
  const scenario = {
    config: CONFIG,
    recipes: [
      { id: 'A', family: 'F1', dailyQuota: 100 },
      { id: 'C', family: 'F2', dailyQuota: 10 },
    ],
    orders: [
      { id: 'p1', recipe: 'A', qty: 5, due: 100 },
      { id: 'p2', recipe: 'C', qty: 8, due: 200 },
      { id: 'p3', recipe: 'C', qty: 8, due: 300, toolingPrepared: true, splittable: false },
    ],
  };
  const plan1 = createPlan(scenario);
  assert.equal(plan1.status, 'ok');
  // p3 (8) does not fit recipe C's remaining day-0 quota (10-8=2) -> day 1.
  const p3Run = plan1.runs.find((r) => r.loads.some((l) => l.orderId === 'p3'));
  assert.equal(p3Run.day, 1);
  assert.equal(plan1.objective.tardiness, 240); // p3 done at 540, due 300

  const plan2 = updatePlan(plan1, { freezeTime: 60, cancelOrders: ['p3'] });
  assert.equal(plan2.status, 'ok');

  // Frozen history unchanged.
  assert.deepEqual(plan2.runs[0], plan1.runs[0]);
  assert.deepEqual(plan2.freezeBoundary.frozenRunIds, [1]);

  // Compensation slots deducted for the prepared tooling.
  assert.deepEqual(plan2.compensations, [{ orderId: 'p3', slots: 2, duration: 30 }]);
  assert.equal(plan2.objective.compensation, 30);
  assert.equal(
    plan2.objective.total,
    plan2.objective.tardiness + plan2.objective.cleanout + plan2.objective.compensation,
  );

  // Quota released: recipe C usage is only p2's 8 units on day 0.
  const usageC = plan2.quotaUsage.filter((q) => q.recipe === 'C');
  assert.deepEqual(usageC, [{ day: 0, recipe: 'C', used: 8, quota: 10 }]);

  // Cancel diff recorded; p3's run removed.
  assert.deepEqual(plan2.diff.canceledOrderIds, ['p3']);
  assert.ok(!plan2.runs.some((r) => r.loads.some((l) => l.orderId === 'p3')));

  t.diagnostic(`cancel plan: ${JSON.stringify(plan2.objective)} diff=${JSON.stringify(plan2.diff)}`);
});

test('cancel of an order with frozen loads is rejected with a warning', (t) => {
  const scenario = {
    config: CONFIG,
    recipes: [{ id: 'A', family: 'F1', dailyQuota: 100 }],
    orders: [{ id: 'p1', recipe: 'A', qty: 5, due: 100 }],
  };
  const plan1 = createPlan(scenario);
  const plan2 = updatePlan(plan1, { freezeTime: 60, cancelOrders: ['p1'] });
  assert.equal(plan2.status, 'ok');
  assert.equal(plan2.warnings.length, 1);
  assert.match(plan2.warnings[0], /cancel rejected/);
  assert.deepEqual(plan2.diff.canceledOrderIds, []);
  assert.ok(plan2.runs.some((r) => r.loads.some((l) => l.orderId === 'p1')));
  t.diagnostic(`frozen cancel rejected: ${plan2.warnings[0]}`);
});
