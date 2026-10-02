import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDag, parseBudget } from '../src/dag.js';
import { planAll, planReport } from '../src/planner.js';
import { DIMS, EPS, effectiveCost, fits } from '../src/resources.js';
import { lcg, randomDag, randomBudget } from './helpers.js';

// Independent brute-force reference: enumerate every self-closed bitmask.
function bruteForce(dagObj, budgetObj) {
  const dag = parseDag(dagObj);
  const budget = parseBudget(budgetObj);
  const ids = dag.ids;
  const n = ids.length;
  const idx = new Map(ids.map((id, i) => [id, i]));
  const bit = (i) => 2 ** i;
  const closeMask = ids.map((id) => {
    let m = bit(idx.get(id));
    for (const a of dag.ancestors(id)) m += bit(idx.get(a));
    return m;
  });
  const costs = ids.map((id) => effectiveCost(dag.tasks.get(id), budget));
  const values = ids.map((id) => dag.tasks.get(id).value);
  let best = -Infinity;
  let ties = [];
  for (let mask = 0; mask < 2 ** n; mask++) {
    let closed = 0;
    for (let i = 0; i < n; i++) if (mask & bit(i)) closed |= closeMask[i];
    if (closed !== mask) continue; // only evaluate dependency-closed sets, once each
    const c = { cpu: 0, mem: 0, wall: 0 };
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (mask & bit(i)) {
        for (const d of DIMS) c[d] += costs[i][d];
        v += values[i];
      }
    }
    if (!fits(c, budget)) continue;
    if (v > best + EPS) {
      best = v;
      ties = [mask];
    } else if (v >= best - EPS) {
      ties.push(mask);
    }
  }
  const keyOf = (m) => ids.filter((_, i) => m & bit(i)).join(',');
  return { best, keys: ties.map(keyOf).sort() };
}

test('acceptance 1: planner matches exhaustive enumeration for up to 20 tasks', () => {
  const rng = lcg(20261002);
  const sizes = [...Array(15).fill(0).map(() => 1 + Math.floor(rng() * 15)), 16, 16, 20];
  for (const n of sizes) {
    const dagObj = randomDag(rng, n, 0.2);
    const budgetObj = randomBudget(rng, dagObj);
    const dag = parseDag(dagObj);
    const budget = parseBudget(budgetObj);
    const result = planAll(dag, budget, {});
    const ref = bruteForce(dagObj, budgetObj);
    assert.ok(Math.abs(result.value - ref.best) < EPS, `n=${n}: value ${result.value} != ${ref.best}`);
    assert.deepEqual(result.plans.map((p) => p.key), ref.keys, `n=${n}: tied plan sets differ`);
  }
});

test('acceptance 2: budget exactly equal to demand is feasible (boundary inclusive)', () => {
  const dag = parseDag({ tasks: [
    { id: 'a', deps: [], cpu: 2, mem: 1, wall: 5, failRate: 0 },
    { id: 'b', deps: [], cpu: 3, mem: 2, wall: 5, failRate: 0 },
  ] });
  const exact = parseBudget({ cpu: 5, mem: 3, wall: 10 });
  const r1 = planAll(dag, exact, {});
  assert.equal(r1.plans.length, 1);
  assert.deepEqual(r1.plans[0].tasks, ['a', 'b']);
  assert.deepEqual(r1.plans[0].cost, { cpu: 5, mem: 3, wall: 10 });
  const short = parseBudget({ cpu: 4, mem: 3, wall: 10 });
  const r2 = planAll(dag, short, {});
  assert.equal(r2.value, 1); // can no longer take both
});

test('NULL resource = conservative upper bound (whole budget dimension), not infinity', () => {
  const dag = parseDag({ tasks: [
    { id: 'unknown1', deps: [], cpu: null, mem: 1, wall: 1, failRate: 0 },
    { id: 'unknown2', deps: [], cpu: null, mem: 1, wall: 1, failRate: 0 },
    { id: 'known', deps: [], cpu: 1, mem: 1, wall: 1, failRate: 0 },
  ] });
  const budget = parseBudget({ cpu: 4, mem: 10, wall: 10 });
  const r = planAll(dag, budget, {});
  // each unknown task consumes the full cpu budget (4): two of them never fit
  // together, and an unknown never fits together with the known cpu=1 task.
  for (const p of r.plans) {
    const hasU1 = p.tasks.includes('unknown1');
    const hasU2 = p.tasks.includes('unknown2');
    assert.ok(!(hasU1 && hasU2), 'two NULL-cpu tasks must not share a plan');
    assert.ok(!(p.tasks.includes('known') && (hasU1 || hasU2)), 'NULL cpu + known cpu exceed the bound');
  }
  // but a single unknown is schedulable, consuming exactly the budget
  const withU1 = r.plans.find((p) => p.tasks.includes('unknown1'));
  assert.ok(withU1);
  assert.equal(withU1.cost.cpu, 4);
});

test('NULL budget dimension is unconstrained', () => {
  const dag = parseDag({ tasks: [
    { id: 'a', deps: [], cpu: 100, mem: 1, wall: 1, failRate: 0 },
    { id: 'b', deps: [], cpu: 200, mem: 1, wall: 1, failRate: 0 },
  ] });
  const r = planAll(dag, parseBudget({ cpu: null, mem: 5, wall: 5 }), {});
  assert.deepEqual(r.plans[0].tasks, ['a', 'b']);
});

test('tied optima are all listed, ordered by deterministic key, stable across runs', () => {
  const dagObj = { tasks: [
    { id: 'c', deps: [], cpu: 1, mem: 1, wall: 1, failRate: 0 },
    { id: 'a', deps: [], cpu: 1, mem: 1, wall: 1, failRate: 0 },
    { id: 'b', deps: [], cpu: 1, mem: 1, wall: 1, failRate: 0 },
  ] };
  const budget = parseBudget({ cpu: 2, mem: 2, wall: 2 });
  const r1 = planAll(parseDag(dagObj), budget, {});
  assert.equal(r1.value, 2);
  assert.deepEqual(r1.plans.map((p) => p.key), ['a,b', 'a,c', 'b,c']);
  const r2 = planAll(parseDag(dagObj), budget, {});
  assert.deepEqual(r2.plans.map((p) => p.key), r1.plans.map((p) => p.key));
});

test('acceptance 4: dropping a selected task releases budget and triggers re-planning', () => {
  const dagObj = { tasks: [
    { id: 'big', deps: [], cpu: 5, mem: 1, wall: 1, failRate: 0, value: 3 },
    { id: 'small1', deps: [], cpu: 3, mem: 1, wall: 1, failRate: 0, value: 2 },
    { id: 'small2', deps: [], cpu: 3, mem: 1, wall: 1, failRate: 0, value: 2 },
  ] };
  const budget = parseBudget({ cpu: 6, mem: 10, wall: 10 });
  const before = planAll(parseDag(dagObj), budget, {});
  assert.deepEqual(before.plans.map((p) => p.key), ['small1,small2']); // value 4 beats big (3)
  const after = planAll(parseDag(dagObj), budget, { drop: ['small1'] });
  assert.deepEqual(after.plans.map((p) => p.key), ['big']); // freed budget lets big in
  assert.ok(!after.plans[0].tasks.includes('small1'));
});

test('dropping a task also excludes its dependents (closure cannot re-add it)', () => {
  const dagObj = { tasks: [
    { id: 'base', deps: [], cpu: 1, mem: 1, wall: 1, failRate: 0, value: 10 },
    { id: 'child', deps: ['base'], cpu: 1, mem: 1, wall: 1, failRate: 0, value: 10 },
    { id: 'other', deps: [], cpu: 1, mem: 1, wall: 1, failRate: 0, value: 1 },
  ] };
  const budget = parseBudget({ cpu: 3, mem: 3, wall: 3 });
  const r = planAll(parseDag(dagObj), budget, { drop: ['base'] });
  assert.deepEqual(r.plans[0].tasks, ['other']);
});

test('E_BUDGET when required tasks exceed the budget', () => {
  const dag = parseDag({ tasks: [
    { id: 'a', deps: [], cpu: 4, mem: 1, wall: 1, failRate: 0 },
    { id: 'b', deps: [], cpu: 4, mem: 1, wall: 1, failRate: 0 },
  ] });
  assert.throws(
    () => planAll(dag, parseBudget({ cpu: 5, mem: 5, wall: 5 }), { require: ['a', 'b'] }),
    (e) => e.code === 'E_BUDGET',
  );
});

test('unknown (null) failRate enters intervals and never blocks scheduling', () => {
  const dag = parseDag({ tasks: [
    { id: 'mystery', deps: [], cpu: 1, mem: 1, wall: 1, failRate: null, maxRetries: 2 },
  ] });
  const budget = parseBudget({ cpu: 1, mem: 1, wall: 1 });
  const r = planAll(dag, budget, {});
  assert.deepEqual(r.plans[0].tasks, ['mystery']); // schedulable despite unknown rate
  const report = planReport(dag, r.plans[0]);
  assert.deepEqual(report.reproducibility, [0, 1]); // full interval
});

test('dependency closure: selecting a task pulls in its ancestors', () => {
  const dag = parseDag({ tasks: [
    { id: 'leaf', deps: ['mid'], cpu: 1, mem: 1, wall: 1, failRate: 0, value: 5 },
    { id: 'mid', deps: ['root'], cpu: 1, mem: 1, wall: 1, failRate: 0, value: 0 },
    { id: 'root', deps: [], cpu: 1, mem: 1, wall: 1, failRate: 0, value: 0 },
  ] });
  const r = planAll(dag, parseBudget({ cpu: 3, mem: 3, wall: 3 }), {});
  assert.deepEqual(r.plans[0].tasks, ['leaf', 'mid', 'root']);
});
