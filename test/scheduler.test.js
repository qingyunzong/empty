import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateProblem } from '../src/problem.js';
import { Scheduler } from '../src/scheduler.js';
import { minimalConflict } from '../src/conflict.js';

function feasibleProblem() {
  return validateProblem({
    horizon: 40,
    tanks: [
      { id: 'T1', material: 'steel', capacity: 500 },
      { id: 'T2', material: 'glass', capacity: 300 },
    ],
    compatibility: { X: ['steel', 'glass'], Y: ['steel'] },
    cleaning: [
      { from: 'X', to: 'Y', time: 5 },
      { from: 'Y', to: 'X', time: 5 },
    ],
    tasks: [
      { id: 'A', material: 'X', minCapacity: 100, maxCapacity: 600, earliestStart: 0, latestStart: 20, duration: 10 },
      { id: 'B', material: 'Y', minCapacity: 100, maxCapacity: 500, earliestStart: 0, latestStart: 20, duration: 8 },
      { id: 'C', material: 'X', minCapacity: 200, maxCapacity: 500, earliestStart: 5, latestStart: 25, duration: 12 },
    ],
  });
}

function cleaningTime(problem, from, to) {
  if (from === to) return 0;
  const rule = problem.cleaning.find((r) => r.from === from && r.to === to);
  return rule ? rule.time : 0;
}

// Independent checker: validates one concrete assignment against every constraint.
function checkAssignment(problem, assignments) {
  const tasks = new Map(problem.tasks.map((t) => [t.id, t]));
  const tanks = new Map(problem.tanks.map((t) => [t.id, t]));
  assert.equal(assignments.length, problem.tasks.length);
  const seen = new Set();
  for (const a of assignments) {
    const task = tasks.get(a.task);
    const tank = tanks.get(a.tank);
    assert.ok(task, `unknown task ${a.task}`);
    assert.ok(tank, `unknown tank ${a.tank}`);
    assert.ok(!seen.has(a.task));
    seen.add(a.task);
    assert.ok(Number.isInteger(a.start) && a.start >= task.earliestStart);
    const latest = task.latestStart ?? problem.horizon - task.duration;
    assert.ok(a.start <= latest, `${a.task} start ${a.start} after latest ${latest}`);
    assert.ok(a.start + task.duration <= problem.horizon);
    assert.equal(a.end, a.start + task.duration);
    assert.ok(tank.capacity >= task.minCapacity && tank.capacity <= task.maxCapacity);
    if (problem.compatibility) {
      assert.ok(problem.compatibility[task.material].includes(tank.material));
    }
    if (task.locked) {
      assert.equal(a.tank, task.tank);
      assert.equal(a.start, task.start);
    }
  }
  for (let i = 0; i < assignments.length; i += 1) {
    for (let j = i + 1; j < assignments.length; j += 1) {
      const p = assignments[i];
      const q = assignments[j];
      if (p.tank !== q.tank) continue;
      const tp = tasks.get(p.task);
      const tq = tasks.get(q.task);
      const ok =
        p.end + cleaningTime(problem, tp.material, tq.material) <= q.start ||
        q.end + cleaningTime(problem, tq.material, tp.material) <= p.start;
      assert.ok(ok, `cleaning violation between ${p.task} and ${q.task} on ${p.tank}`);
    }
  }
}

// Brute-force oracle: enumerate every tank assignment and start combination.
function bruteForceFeasible(problem) {
  const domains = problem.tasks.map((task) => {
    const tanks = problem.tanks
      .filter((tank) =>
        tank.capacity >= task.minCapacity &&
        tank.capacity <= task.maxCapacity &&
        (!problem.compatibility || problem.compatibility[task.material].includes(tank.material)))
      .map((tank) => tank.id);
    const latest = Math.min(
      task.latestStart ?? Infinity,
      problem.horizon - task.duration,
    );
    const starts = [];
    for (let s = task.earliestStart; s <= latest; s += 1) starts.push(s);
    return { task, combos: tanks.flatMap((tank) => starts.map((start) => ({ tank, start }))) };
  });
  if (domains.some((d) => d.combos.length === 0)) return false;
  const chosen = new Array(domains.length);
  const visit = (i) => {
    if (i === domains.length) return true;
    for (const combo of domains[i].combos) {
      chosen[i] = { ...combo, task: domains[i].task };
      let ok = true;
      for (let k = 0; k < i && ok; k += 1) {
        if (chosen[k].tank !== combo.tank) continue;
        const a = chosen[k];
        const b = combo;
        const ta = a.task;
        const tb = domains[i].task;
        const endA = a.start + ta.duration;
        const endB = b.start + tb.duration;
        ok =
          endA + cleaningTime(problem, ta.material, tb.material) <= b.start ||
          endB + cleaningTime(problem, tb.material, ta.material) <= a.start;
      }
      if (ok && visit(i + 1)) return true;
    }
    return false;
  };
  return visit(0);
}

test('two tanks, three tasks: feasible, verified by enumeration', () => {
  const problem = feasibleProblem();
  const result = new Scheduler(problem).solve();
  assert.equal(result.status, 'feasible');
  checkAssignment(problem, result.assignments);
  assert.equal(bruteForceFeasible(problem), true);
  // Solver and oracle must agree on feasibility.
  assert.equal(result.status === 'feasible', bruteForceFeasible(problem));
});

test('locked task with no feasible window yields a minimal conflict', () => {
  const problem = validateProblem({
    horizon: 40,
    tanks: [{ id: 'T1', material: 'steel', capacity: 500 }],
    compatibility: { X: ['steel'], Y: ['steel'] },
    cleaning: [
      { from: 'X', to: 'Y', time: 15 },
      { from: 'Y', to: 'X', time: 15 },
    ],
    tasks: [
      { id: 'L', material: 'X', minCapacity: 100, maxCapacity: 500, earliestStart: 0, duration: 10, locked: true, tank: 'T1', start: 0 },
      { id: 'B', material: 'Y', minCapacity: 100, maxCapacity: 500, earliestStart: 0, latestStart: 20, duration: 10 },
    ],
  });
  const scheduler = new Scheduler(problem);
  assert.equal(scheduler.consistent, false);
  assert.equal(scheduler.solve().status, 'infeasible');
  const conflict = minimalConflict(problem);
  assert.deepEqual([...conflict.tasks].sort(), ['B', 'L']);
  assert.deepEqual(conflict.locked, ['L']);
  assert.deepEqual(conflict.tanks, ['T1']);
  assert.equal(conflict.cleaning.length, 2);
  assert.ok(conflict.cleaning.some((r) => r.from === 'X' && r.to === 'Y' && r.time === 15));
});

test('tiny budget returns unknown with pending tasks', () => {
  const problem = feasibleProblem();
  const result = new Scheduler(problem).solve({ budget: 0 });
  assert.equal(result.status, 'unknown');
  assert.deepEqual([...result.pending].sort(), ['A', 'B', 'C']);
});

test('failed hold rolls back; locked tasks unaffected; release restores', () => {
  const problem = validateProblem({
    horizon: 40,
    tanks: [
      { id: 'T1', material: 'steel', capacity: 500 },
      { id: 'T2', material: 'steel', capacity: 500 },
    ],
    compatibility: { X: ['steel'], Y: ['steel'] },
    cleaning: [
      { from: 'X', to: 'Y', time: 15 },
      { from: 'Y', to: 'X', time: 15 },
    ],
    tasks: [
      { id: 'L', material: 'X', minCapacity: 100, maxCapacity: 500, earliestStart: 0, duration: 10, locked: true, tank: 'T1', start: 0 },
      { id: 'B', material: 'Y', minCapacity: 100, maxCapacity: 500, earliestStart: 0, latestStart: 30, duration: 5 },
    ],
  });
  const scheduler = new Scheduler(problem);

  // Hold on T1 right after L: cleaning X→Y of 15 makes it infeasible.
  const bad = scheduler.hold({ id: 'H1', tank: 'T1', start: 10, duration: 5, material: 'Y' });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'propagation-failed');
  // Rollback: scheduler consistent again, locked task still fixed.
  assert.equal(scheduler.consistent, true);
  assert.deepEqual(scheduler.fixed.get('L'), { tank: 'T1', start: 0 });
  assert.equal(scheduler.holds.size, 0);
  const after = scheduler.solve();
  assert.equal(after.status, 'feasible');
  checkAssignment(problem, after.assignments);

  // Successful hold, then release.
  assert.equal(scheduler.hold({ id: 'H2', tank: 'T2', start: 0, duration: 5, material: 'X' }).ok, true);
  assert.equal(scheduler.solve().status, 'feasible');
  assert.equal(scheduler.release('H2').ok, true);
  assert.equal(scheduler.release('H2').ok, false);
  assert.equal(scheduler.solve().status, 'feasible');
});

test('hold forces task off a tank; assignment respects the occupation', () => {
  const problem = validateProblem({
    horizon: 30,
    tanks: [{ id: 'T1', material: 'steel', capacity: 500 }],
    compatibility: { X: ['steel'] },
    cleaning: [],
    tasks: [
      { id: 'A', material: 'X', minCapacity: 100, maxCapacity: 500, earliestStart: 0, latestStart: 20, duration: 10 },
    ],
  });
  const scheduler = new Scheduler(problem, {
    holds: [{ id: 'H', tank: 'T1', start: 0, duration: 12, material: 'X' }],
  });
  const result = scheduler.solve();
  assert.equal(result.status, 'feasible');
  const a = result.assignments.find((x) => x.task === 'A');
  assert.ok(a.start >= 12, `A must start after the hold ends, got ${a.start}`);
});
