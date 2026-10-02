import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlan } from '../src/planner.js';

const CONFIG = {
  capacity: 10,
  runDuration: 60,
  cleanoutTime: 30,
  dayLength: 480,
  slotDuration: 15,
  compensationSlots: 2,
};

const RECIPES = [
  { id: 'A', family: 'F1', dailyQuota: 14 },
  { id: 'B', family: 'F1', dailyQuota: 20 },
  { id: 'C', family: 'F2', dailyQuota: 12 },
];

test('mixed runs: capacity, compatibility and daily quota all feasible', (t) => {
  const plan = createPlan({
    config: CONFIG,
    recipes: RECIPES,
    orders: [
      { id: 'o1', recipe: 'A', qty: 8, due: 200 },
      { id: 'o2', recipe: 'B', qty: 6, due: 300 },
      { id: 'o3', recipe: 'C', qty: 10, due: 500 },
      { id: 'o4', recipe: 'A', qty: 8, due: 100 },
    ],
  });
  assert.equal(plan.status, 'ok', plan.reasons.join('; '));

  const familyOf = { A: 'F1', B: 'F1', C: 'F2' };
  for (const run of plan.runs) {
    const total = run.loads.reduce((s, l) => s + l.qty, 0);
    assert.ok(total <= CONFIG.capacity, `run ${run.id} over capacity`);
    const families = new Set(run.loads.map((l) => familyOf[l.recipe]));
    assert.equal(families.size, 1, `run ${run.id} mixes incompatible families`);
    assert.equal(run.family, [...families][0]);
  }

  // Recipe A demand is 16 > daily quota 14, so A must span two days.
  const perDay = {};
  for (const run of plan.runs) {
    for (const load of run.loads) {
      if (load.recipe !== 'A') continue;
      perDay[run.day] = (perDay[run.day] ?? 0) + load.qty;
    }
  }
  assert.deepEqual(perDay, { 0: 14, 1: 2 });

  // Every order fully loaded.
  const loaded = {};
  for (const run of plan.runs) {
    for (const load of run.loads) loaded[load.orderId] = (loaded[load.orderId] ?? 0) + load.qty;
  }
  assert.deepEqual(loaded, { o1: 8, o2: 6, o3: 10, o4: 8 });

  // Objective is consistent and equals the expected schedule cost.
  const { tardiness, cleanout, compensation, total } = plan.objective;
  assert.equal(total, tardiness + cleanout + compensation);
  assert.equal(compensation, 0);
  assert.equal(cleanout, 30); // single F1 -> F2 switch
  assert.equal(tardiness, 470); // o1: 540-200, o3: 630-500
  assert.equal(total, 500);

  t.diagnostic(`mixed-run plan: ${JSON.stringify(plan.objective)} runs=${plan.runs.length}`);
});

test('waiting queue ages by wait time', (t) => {
  const plan = createPlan({
    config: { ...CONFIG, capacity: 5 },
    recipes: [{ id: 'A', family: 'F1', dailyQuota: 100 }],
    orders: [
      { id: 'a', recipe: 'A', qty: 5, due: 500, arrival: 0 },
      { id: 'b', recipe: 'A', qty: 5, due: 500, arrival: 0 },
      { id: 'c', recipe: 'A', qty: 5, due: 500, arrival: 30 },
    ],
  });
  assert.equal(plan.status, 'ok');
  assert.equal(plan.runs[0].loads[0].orderId, 'a');
  // At t=60, b has waited 60 and c only 30: aging puts b first.
  assert.equal(plan.runs[1].loads[0].orderId, 'b');
  assert.equal(plan.runs[2].loads[0].orderId, 'c');
  t.diagnostic(`aging order: ${plan.runs.map((r) => r.loads[0].orderId).join(' -> ')}`);
});

test('over-capacity non-splittable order fails', (t) => {
  const plan = createPlan({
    config: CONFIG,
    recipes: RECIPES,
    orders: [{ id: 'big', recipe: 'A', qty: 12, splittable: false, due: 100 }],
  });
  assert.equal(plan.status, 'failed');
  assert.ok(plan.reasons.some((r) => r.includes('exceeds furnace capacity')));
  t.diagnostic(`over-capacity rejected: ${plan.reasons[0]}`);
});

test('incompatible recipes forced into one run fail', (t) => {
  const plan = createPlan({
    config: CONFIG,
    recipes: RECIPES,
    orders: [
      { id: 'g1', recipe: 'A', qty: 2, due: 100, group: 'G' },
      { id: 'g2', recipe: 'C', qty: 2, due: 100, group: 'G' },
    ],
  });
  assert.equal(plan.status, 'failed');
  assert.ok(plan.reasons.some((r) => r.includes('not compatible')));
  t.diagnostic(`incompatible group rejected: ${plan.reasons[0]}`);
});
