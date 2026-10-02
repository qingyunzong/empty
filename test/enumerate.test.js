import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlan } from '../src/planner.js';
import { enumerateOptimal } from '../src/enumerate.js';
import { normalizeScenario } from '../src/model.js';

const CONFIG = { capacity: 4, runDuration: 60, cleanoutTime: 30, dayLength: 480 };

function optimalFor(scenario) {
  const { errors, config, recipes, orders } = normalizeScenario(scenario);
  assert.deepEqual(errors, []);
  return enumerateOptimal({ orders, recipes, config });
}

test('enumeration finds cleanout-minimal batching and ordering', (t) => {
  const scenario = {
    config: CONFIG,
    recipes: [
      { id: 'A', family: 'F1', dailyQuota: 100 },
      { id: 'B', family: 'F2', dailyQuota: 100 },
    ],
    orders: [
      { id: 'a1', recipe: 'A', qty: 4, due: 100 },
      { id: 'a2', recipe: 'A', qty: 4, due: 100 },
      { id: 'b1', recipe: 'B', qty: 4, due: 100 },
    ],
  };
  const best = optimalFor(scenario);
  // Optimal: A,A,B -> runs 0-60, 60-120, 150-210; tardiness 0+20+110=130, cleanout 30.
  assert.equal(best.objective.total, 160);
  assert.equal(best.objective.cleanout, 30);
  assert.deepEqual(best.runs.map((r) => r.id), [1, 2, 3]);

  // Heuristic agrees with the optimum on this instance.
  const plan = createPlan(scenario);
  assert.equal(plan.objective.total, best.objective.total);

  // Deterministic tie-break by run numbering: repeated runs are identical.
  const again = optimalFor(scenario);
  assert.deepEqual(again, best);

  t.diagnostic(`enumerate optimum=${best.objective.total} heuristic=${plan.objective.total}`);
});

test('enumeration respects daily quota by pushing runs to the next day', (t) => {
  const scenario = {
    config: CONFIG,
    recipes: [{ id: 'A', family: 'F1', dailyQuota: 4 }],
    orders: [
      { id: 'a1', recipe: 'A', qty: 4, due: 1000 },
      { id: 'a2', recipe: 'A', qty: 4, due: 1000 },
    ],
  };
  const best = optimalFor(scenario);
  assert.equal(best.runs.length, 2);
  assert.equal(best.runs[0].day, 0);
  assert.equal(best.runs[1].day, 1);
  assert.equal(best.runs[1].start, 480);
  t.diagnostic(`quota-constrained optimum: ${JSON.stringify(best.objective)}`);
});

test('heuristic is never better than the enumerated optimum (<=5 orders)', (t) => {
  const scenario = {
    config: { capacity: 8, runDuration: 60, cleanoutTime: 30, dayLength: 480 },
    recipes: [
      { id: 'A', family: 'F1', dailyQuota: 100 },
      { id: 'B', family: 'F2', dailyQuota: 100 },
    ],
    orders: [
      { id: 'a1', recipe: 'A', qty: 5, due: 100 },
      { id: 'b1', recipe: 'B', qty: 5, due: 200 },
      { id: 'a2', recipe: 'A', qty: 3, due: 300 },
      { id: 'b2', recipe: 'B', qty: 4, due: 400 },
      { id: 'a3', recipe: 'A', qty: 2, due: 500 },
    ],
  };
  const best = optimalFor(scenario);
  const plan = createPlan(scenario);
  assert.equal(plan.status, 'ok');
  assert.ok(plan.objective.total >= best.objective.total);
  t.diagnostic(`5-order cross-check: heuristic=${plan.objective.total} optimal=${best.objective.total}`);
});
