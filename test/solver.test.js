import test from 'node:test';
import assert from 'node:assert/strict';
import { solveWithConflict, verifyAssignment } from '../src/solver.js';

// Brute-force reference: enumerate every tank assignment and every
// per-tank permutation, place tasks greedily at the earliest valid time.
function bruteForceAssignment(input) {
  const cleaning = (a, b) => {
    if (a === b) return 0;
    const rule = (input.cleaning ?? []).find((r) => r.from === a && r.to === b);
    return rule ? rule.time : (input.defaultCleaningTime ?? 0);
  };
  const horizon = input.horizon ?? 1000;
  const tasks = input.tasks;
  const compatible = tasks.map((t) =>
    input.tanks
      .map((tk, i) => i)
      .filter(
        (i) =>
          input.tanks[i].capacity >= t.minCapacity &&
          input.tanks[i].capacity <= t.maxCapacity &&
          input.tanks[i].materials.includes(t.material) &&
          (t.tank === undefined || input.tanks[i].id === t.tank),
      ),
  );
  function* permutations(arr) {
    if (arr.length <= 1) { yield arr; return; }
    for (let i = 0; i < arr.length; i++) {
      const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
      for (const p of permutations(rest)) yield [arr[i], ...p];
    }
  }
  function* products(lists, acc = []) {
    if (acc.length === lists.length) { yield acc; return; }
    for (const item of lists[acc.length]) yield* products(lists, [...acc, item]);
  }
  function* tankCombos(i, acc) {
    if (i === tasks.length) { yield acc; return; }
    for (const t of compatible[i]) yield* tankCombos(i + 1, [...acc, t]);
  }
  for (const combo of tankCombos(0, [])) {
    const perTank = input.tanks.map(() => []);
    combo.forEach((tankIdx, taskIdx) => perTank[tankIdx].push(taskIdx));
    const permsPerTank = perTank.map((list) => [...permutations(list)]);
    for (const permCombo of products(permsPerTank)) {
      const assignment = {};
      let ok = true;
      for (let tankIdx = 0; tankIdx < input.tanks.length && ok; tankIdx++) {
        let cursor = 0;
        let prev = null;
        for (const taskIdx of permCombo[tankIdx]) {
          const t = tasks[taskIdx];
          const locked = t.locked === true;
          let start = Math.max(t.earliestStart ?? 0, cursor);
          if (locked) {
            if (t.start < start) { ok = false; break; }
            start = t.start;
          }
          const deadline = t.deadline ?? horizon;
          if (start + t.duration > deadline) { ok = false; break; }
          assignment[t.id] = { tank: input.tanks[tankIdx].id, start, end: start + t.duration };
          cursor = start + t.duration + (prev === null ? 0 : cleaning(tasks[prev].material, t.material));
          prev = taskIdx;
        }
      }
      if (ok) return assignment;
    }
  }
  return null;
}

test('acceptance 1: two tanks / three tasks feasible, cross-checked by enumeration', () => {
  const input = {
    horizon: 12,
    tanks: [
      { id: 'T1', capacity: 100, materials: ['A', 'B'] },
      { id: 'T2', capacity: 60, materials: ['A'] },
    ],
    cleaning: [
      { from: 'A', to: 'B', time: 2 },
      { from: 'B', to: 'A', time: 1 },
    ],
    tasks: [
      { id: 'J1', material: 'A', minCapacity: 40, maxCapacity: 120, duration: 3, deadline: 12 },
      { id: 'J2', material: 'B', minCapacity: 70, maxCapacity: 120, duration: 2, deadline: 12 },
      { id: 'J3', material: 'A', minCapacity: 30, maxCapacity: 60, duration: 4, deadline: 12 },
    ],
  };
  const result = solveWithConflict(input);
  assert.equal(result.status, 'feasible');

  // Solver's own independent checker accepts it.
  assert.deepEqual(verifyAssignment(input, result.assignment), { ok: true });

  // Enumeration over tank numbers x permutations agrees a solution exists.
  const brute = bruteForceAssignment(input);
  assert.notEqual(brute, null, 'brute-force enumeration should find a feasible assignment');

  // J2 needs capacity >= 70, so it can only go to T1; J3 fits both.
  assert.equal(result.assignment.J2.tank, 'T1');
});

test('acceptance 2: locked task leaves no feasible window -> minimal conflict', () => {
  const input = {
    horizon: 10,
    tanks: [{ id: 'T1', capacity: 100, materials: ['A', 'B'] }],
    cleaning: [{ from: 'A', to: 'B', time: 3 }],
    tasks: [
      { id: 'L1', material: 'A', minCapacity: 10, maxCapacity: 100, duration: 4, locked: true, tank: 'T1', start: 3 },
      { id: 'J1', material: 'B', minCapacity: 10, maxCapacity: 100, duration: 4, deadline: 10 },
    ],
  };
  const result = solveWithConflict(input);
  assert.equal(result.status, 'infeasible');
  assert.ok(result.conflict, 'conflict must be reported');
  assert.deepEqual([...result.conflict.tasks].sort(), ['J1', 'L1']);
  assert.deepEqual(result.conflict.tanks, ['T1']);
  assert.deepEqual(result.conflict.cleaningRules, [{ from: 'A', to: 'B', time: 3 }]);
});

test('acceptance 3: tiny budget -> unknown with pending; after release -> feasible', () => {
  const base = {
    horizon: 12,
    tanks: [{ id: 'T1', capacity: 100, materials: ['A'] }],
    tasks: [
      { id: 'J1', material: 'A', minCapacity: 10, maxCapacity: 100, duration: 2, deadline: 12 },
      { id: 'J2', material: 'A', minCapacity: 10, maxCapacity: 100, duration: 2, deadline: 12 },
    ],
  };
  const withHold = { ...base, holds: [{ id: 'H1', tank: 'T1', start: 0, duration: 8 }] };

  const starved = solveWithConflict(withHold, { budget: 0 });
  assert.equal(starved.status, 'unknown');
  assert.deepEqual([...starved.pending].sort(), ['J1', 'J2']);

  // Releasing the hold (solving without it) yields a feasible plan.
  const released = solveWithConflict(base);
  assert.equal(released.status, 'feasible');
  assert.deepEqual(verifyAssignment(base, released.assignment), { ok: true });

  // Sanity: with the hold and a real budget it is still feasible (tasks fit in [8,12]).
  const held = solveWithConflict(withHold);
  assert.equal(held.status, 'feasible');
  assert.deepEqual(verifyAssignment(withHold, held.assignment), { ok: true });
});
