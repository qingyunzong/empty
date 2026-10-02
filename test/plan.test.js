import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDag, topoOrder } from '../src/dag.js';
import { parseBudget } from '../src/budget.js';
import { findOptimalPlans } from '../src/plan.js';
import { explainPlan } from '../src/explain.js';
import { ReplanError } from '../src/errors.js';
import { rng, randomDagDoc, randomBudget } from './helpers.js';

// Independent naive brute force used as the oracle for acceptance check 1.
function bruteForce(doc, budget) {
  const tasks = parseDag(doc);
  const ids = [...tasks.keys()];
  const n = ids.length;
  const eff = (t, dim) => (t.cost[dim] === null ? budget[dim] : t.cost[dim]);
  let best = -Infinity;
  let bestSets = [];
  for (let mask = 0; mask < 2 ** n; mask++) {
    const set = new Set();
    for (let i = 0; i < n; i++) if (mask & (1 << i)) set.add(ids[i]);
    let closed = true;
    for (const id of set) {
      for (const d of tasks.get(id).deps) {
        if (!set.has(d)) { closed = false; break; }
      }
      if (!closed) break;
    }
    if (!closed) continue;
    const cost = { cpu: 0, mem: 0, wall: 0 };
    let value = 0;
    for (const id of set) {
      const t = tasks.get(id);
      value += t.value;
      for (const dim of ['cpu', 'mem', 'wall']) cost[dim] += eff(t, dim);
    }
    if (cost.cpu > budget.cpu || cost.mem > budget.mem || cost.wall > budget.wall) continue;
    const key = [...set].sort();
    if (value > best) { best = value; bestSets = [key]; }
    else if (value === best) bestSets.push(key);
  }
  bestSets.sort((a, b) => (a.join('\0') < b.join('\0') ? -1 : 1));
  return { value: best, plans: bestSets };
}

test('acceptance 1: planner matches exhaustive brute force on random DAGs (n<=12)', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rand = rng(seed);
    const n = 4 + Math.floor(rand() * 9); // 4..12
    const doc = randomDagDoc(n, rand, { edgeProb: 0.3 });
    const budget = randomBudget(rand);
    const tasks = parseDag(doc);
    const got = findOptimalPlans(tasks, budget, {});
    const want = bruteForce(doc, budget);
    assert.equal(got.value, want.value, `seed=${seed} value`);
    assert.deepEqual(got.plans, want.plans, `seed=${seed} tied plan sets`);
  }
});

test('acceptance 1: 20-task case matches exhaustive optimum', () => {
  const rand = rng(2024);
  const doc = randomDagDoc(20, rand, { edgeProb: 0.15 });
  const budget = { cpu: 12, mem: 12, wall: 12 };
  const tasks = parseDag(doc);
  const got = findOptimalPlans(tasks, budget, {});
  const want = bruteForce(doc, budget);
  assert.equal(got.value, want.value);
  assert.deepEqual(got.plans, want.plans);
});

test('tied optimal plans are all listed, sorted by deterministic key, no randomness', () => {
  const doc = {
    tasks: [
      { id: 'c', deps: [], cost: { cpu: 1, mem: 0, wall: 0 }, value: 1 },
      { id: 'a', deps: [], cost: { cpu: 1, mem: 0, wall: 0 }, value: 1 },
      { id: 'b', deps: [], cost: { cpu: 1, mem: 0, wall: 0 }, value: 1 },
    ],
  };
  const tasks = parseDag(doc);
  const budget = { cpu: 2, mem: 0, wall: 0 };
  const got = findOptimalPlans(tasks, budget, {});
  assert.equal(got.value, 2);
  assert.deepEqual(got.plans, [['a', 'b'], ['a', 'c'], ['b', 'c']]);
  // Determinism: repeated calls give identical results.
  const again = findOptimalPlans(tasks, budget, {});
  assert.deepEqual(again, got);
});

test('acceptance 2: budget exactly equal to demand boundary is feasible', () => {
  const doc = {
    tasks: [
      { id: 'a', deps: [], cost: { cpu: 2, mem: 3, wall: 1 }, value: 5 },
      { id: 'b', deps: ['a'], cost: { cpu: 2, mem: 1, wall: 4 }, value: 7 },
    ],
  };
  const tasks = parseDag(doc);
  const budget = { cpu: 4, mem: 4, wall: 5 }; // exactly the summed demand
  const got = findOptimalPlans(tasks, budget, {});
  assert.equal(got.value, 12);
  assert.deepEqual(got.plans, [['a', 'b']]);
});

test('NULL cost participates as conservative upper bound, not infinite, not free', () => {
  const doc = {
    tasks: [
      { id: 'unknown', deps: [], cost: { cpu: null, mem: 0, wall: 0 }, value: 5 },
      { id: 'known', deps: [], cost: { cpu: 1, mem: 0, wall: 0 }, value: 4 },
    ],
  };
  const tasks = parseDag(doc);
  const budget = { cpu: 4, mem: 0, wall: 0 };
  // unknown is charged the full cpu budget (4), so it cannot share with known.
  const got = findOptimalPlans(tasks, budget, {});
  assert.deepEqual(got.plans, [['unknown']]);
  // The upper bound tracks the budget: with cpu budget 3, unknown is charged 3
  // and now shares the budget with nothing that needs cpu, while known (cost 1)
  // fits alongside nothing else... so the optimum is still unknown alone (5 > 4).
  const got2 = findOptimalPlans(tasks, { cpu: 3, mem: 0, wall: 0 }, {});
  assert.deepEqual(got2.plans, [['unknown']]);
  // With cpu budget 1, unknown is charged 1; both fit together now (1+1 <= ... no:
  // 1+1 > 1), so still a single task, and the higher value wins.
  const got3 = findOptimalPlans(tasks, { cpu: 1, mem: 0, wall: 0 }, {});
  assert.deepEqual(got3.plans, [['unknown']]);
});

test('unknown failRate enters interval and is never unschedulable', () => {
  const doc = {
    tasks: [
      { id: 'mystery', deps: [], cost: { cpu: 1, mem: 1, wall: 1 }, failRate: null, value: 3 },
      { id: 'known', deps: [], cost: { cpu: 1, mem: 1, wall: 1 }, failRate: 0.5, value: 3 },
    ],
  };
  const tasks = parseDag(doc);
  const budget = { cpu: 2, mem: 2, wall: 2 };
  const got = findOptimalPlans(tasks, budget, {});
  assert.deepEqual(got.plans, [['known', 'mystery']]);
  const x = explainPlan(tasks, budget, {});
  assert.equal(x.successInterval[0], 0); // null rate -> [0,1] -> lower bound 0
  assert.ok(x.successInterval[1] > 0 && x.successInterval[1] <= 1);
});

test('E_CYCLE on cyclic graph', () => {
  const doc = {
    tasks: [
      { id: 'a', deps: ['b'] },
      { id: 'b', deps: ['c'] },
      { id: 'c', deps: ['a'] },
      { id: 'd', deps: [] },
    ],
  };
  const tasks = parseDag(doc);
  assert.throws(() => topoOrder(tasks), (e) => e instanceof ReplanError && e.code === 'E_CYCLE');
});

test('E_BUDGET when required tasks cannot fit', () => {
  const doc = {
    tasks: [
      { id: 'big', deps: [], cost: { cpu: 10, mem: 0, wall: 0 }, value: 1 },
    ],
  };
  const tasks = parseDag(doc);
  assert.throws(
    () => findOptimalPlans(tasks, { cpu: 4, mem: 0, wall: 0 }, { require: ['big'] }),
    (e) => e.code === 'E_BUDGET',
  );
});

test('require/exclude/done options constrain the plan', () => {
  const doc = {
    tasks: [
      { id: 'a', deps: [], cost: { cpu: 1, mem: 0, wall: 0 }, value: 1 },
      { id: 'b', deps: ['a'], cost: { cpu: 1, mem: 0, wall: 0 }, value: 10 },
      { id: 'c', deps: [], cost: { cpu: 1, mem: 0, wall: 0 }, value: 5 },
    ],
  };
  const tasks = parseDag(doc);
  const budget = { cpu: 2, mem: 0, wall: 0 };
  // require b forces its dependency a in.
  const got = findOptimalPlans(tasks, budget, { require: ['b'] });
  assert.deepEqual(got.plans, [['a', 'b']]);
  // exclude a makes b unselectable.
  const got2 = findOptimalPlans(tasks, budget, { exclude: ['a'] });
  assert.deepEqual(got2.plans, [['c']]);
  // done a satisfies b's dependency for free.
  const got3 = findOptimalPlans(tasks, budget, { done: new Set(['a']) });
  assert.deepEqual(got3.plans, [['b', 'c']]);
});

test('budget document validation', () => {
  assert.throws(() => parseBudget({ cpu: 1, mem: 1 }), (e) => e.code === 'E_BUDGET');
  assert.throws(() => parseBudget({ cpu: -1, mem: 0, wall: 0 }), (e) => e.code === 'E_BUDGET');
  assert.throws(() => parseBudget({ cpu: null, mem: 0, wall: 0 }), (e) => e.code === 'E_BUDGET');
});
