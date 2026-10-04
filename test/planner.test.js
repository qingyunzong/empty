import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWave, minimalReduction, evaluate, normalizeTasks } from '../src/planner.js';
import { normalizeShuttle } from '../src/model.js';
import { shuttle, runCli, toJsonl } from '../support/helpers.mjs';

// Independent reference enumerator: permutations of tasks x weak compositions
// into shuttle groups, evaluated with the same candidate semantics.
function* permutations(arr) {
  if (arr.length <= 1) { yield arr.slice(); return; }
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) yield [arr[i], ...p];
  }
}

function* compositions(n, parts) {
  if (parts === 1) { yield [n]; return; }
  for (let i = 0; i <= n; i++) {
    for (const rest of compositions(n - i, parts - 1)) yield [i, ...rest];
  }
}

function referenceBest(tasks, shuttles, budget) {
  tasks = normalizeTasks(tasks);
  shuttles = shuttles.map(normalizeShuttle);
  let best = null;
  const ties = [];
  for (const perm of permutations(tasks)) {
    for (const sizes of compositions(tasks.length, shuttles.length)) {
      const assignment = new Map(shuttles.map((s) => [s.id, []]));
      let offset = 0;
      sizes.forEach((size, i) => {
        assignment.set(shuttles[i].id, perm.slice(offset, offset + size));
        offset += size;
      });
      const result = evaluate(assignment, shuttles, budget);
      if (!result.feasible) continue;
      const cand = { makespan: result.makespan, energy: result.energy, pathKey: result.pathKey };
      if (best === null || compare(cand, best) < 0) best = cand;
      ties.push(cand);
    }
  }
  return { best, ties };
}

function compare(a, b) {
  if (a.makespan !== b.makespan) return a.makespan - b.makespan;
  if (a.energy !== b.energy) return a.energy - b.energy;
  return a.pathKey < b.pathKey ? -1 : a.pathKey > b.pathKey ? 1 : 0;
}

const T = (id, moves) => ({ id, moves });

test('acceptance 1: planner matches exhaustive reference optimum', () => {
  const shuttles = [shuttle('S1', 'A1:0'), shuttle('S2', 'A2:0')];
  const tasks = [
    T('T1', [{ id: 'M1', from: 'A1:0', to: 'A1:3', energy: 3, duration: 3 }]),
    T('T2', [{ id: 'M2', from: 'A1:1', to: 'A2:2', energy: 4, duration: 2 }]),
    T('T3', [{ id: 'M3', from: 'A2:0', to: 'A2:2', energy: 2, duration: 2 }]),
    T('T4', [{ id: 'M4', from: 'A1:2', to: 'A1:4', energy: 2, duration: 2 }]),
  ];
  const budget = 30;
  const planned = planWave({ tasks, shuttles, budget });
  const reference = referenceBest(tasks, shuttles, budget);
  assert.ok(planned.feasible);
  assert.equal(planned.makespan, reference.best.makespan);
  assert.equal(planned.energy, reference.best.energy);
  assert.equal(planned.pathKey, reference.best.pathKey);
});

test('acceptance 1: ties broken by completion time, energy, then path order', () => {
  // Symmetric shuttles and interchangeable tasks force multiple optima that
  // differ only in the path key.
  const shuttles = [shuttle('S1', 'A1:0'), shuttle('S2', 'A1:0')];
  const tasks = [
    T('T1', [{ id: 'M1', from: 'A1:0', to: 'A1:1', energy: 1, duration: 1 }]),
    T('T2', [{ id: 'M2', from: 'A1:0', to: 'A1:1', energy: 1, duration: 1 }]),
  ];
  const planned = planWave({ tasks, shuttles, budget: 10 });
  const reference = referenceBest(tasks, shuttles, 10);
  const optimalTies = reference.ties.filter(
    (c) => c.makespan === reference.best.makespan && c.energy === reference.best.energy,
  );
  assert.ok(optimalTies.length > 1, 'expected a genuine tie among optima');
  const lexMin = optimalTies.map((c) => c.pathKey).sort()[0];
  assert.equal(planned.pathKey, lexMin);
  assert.equal(planned.makespan, reference.best.makespan);
  assert.equal(planned.energy, reference.best.energy);
});

test('acceptance 4: battery exactly equal to demand is feasible', () => {
  const shuttles = [shuttle('S1', 'A1:0')];
  const tasks = [
    T('T1', [{ id: 'M1', from: 'A1:0', to: 'A1:3', energy: 3, duration: 3 }]),
    T('T2', [{ id: 'M2', from: 'A1:3', to: 'A1:5', energy: 2, duration: 2 }]),
  ];
  const exact = planWave({ tasks, shuttles, budget: 5 });
  assert.ok(exact.feasible);
  assert.equal(exact.energy, 5);
  assert.ok(!planWave({ tasks, shuttles, budget: 4 }).feasible);
});

test('budget shortfall exits 17 with the minimal reduction set', () => {
  const input = toJsonl([
    { type: 'config', wave: 'W1', budget: 4, shuttles: [{ id: 'S1', home: 'A1:0' }] },
    { type: 'task', id: 'T1', moves: [{ id: 'M1', from: 'A1:0', to: 'A1:3', energy: 3, duration: 3 }] },
    { type: 'task', id: 'T2', moves: [{ id: 'M2', from: 'A1:3', to: 'A1:5', energy: 2, duration: 2 }] },
  ]);
  const r = runCli(['wave'], input);
  assert.equal(r.code, 17);
  const err = r.lines.find((l) => l.type === 'error');
  assert.equal(err.code, 'BUDGET_INSUFFICIENT');
  // Removing T2 leaves 3 <= 4. Removing T1 leaves T2 plus a 3-energy
  // reposition = 5 > 4, so T2 is the only minimal cut.
  assert.deepEqual(err.minimalReduction, ['T2']);
});

test('minimal reduction prefers minimum cardinality then lexicographic order', () => {
  const shuttles = [shuttle('S1', 'A1:0')];
  const tasks = [
    T('TA', [{ id: 'MA', from: 'A1:0', to: 'A1:1', energy: 1, duration: 1 }]),
    T('TB', [{ id: 'MB', from: 'A1:1', to: 'A1:2', energy: 1, duration: 1 }]),
    T('TC', [{ id: 'MC', from: 'A1:2', to: 'A1:3', energy: 1, duration: 1 }]),
  ];
  // Budget 1: any single removal still leaves 2 > 1, so cardinality 2.
  const reduction = minimalReduction({ tasks, shuttles, budget: 1 });
  // Only removing {TB, TC} works: TA starts at the shuttle home so it needs
  // no repositioning, while TB/TC would each add reposition energy.
  assert.deepEqual(reduction, ['TB', 'TC']);
});

test('repositioning energy counts against the budget', () => {
  const shuttles = [shuttle('S1', 'A1:0')];
  const tasks = [T('T1', [{ id: 'M1', from: 'A1:2', to: 'A1:3', energy: 1, duration: 1 }])];
  // Reposition A1:0 -> A1:2 costs 2, task costs 1: total 3.
  assert.ok(planWave({ tasks, shuttles, budget: 3 }).feasible);
  assert.ok(!planWave({ tasks, shuttles, budget: 2 }).feasible);
});
