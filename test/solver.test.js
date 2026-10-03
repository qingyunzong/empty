import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solve, enumerateAll } from '../src/solver.js';

function canonicalBest(jobs, molds, shifts) {
  const all = enumerateAll(jobs, molds, shifts);
  if (all.length === 0) return null;
  const moldIdx = new Map(molds.map((m, i) => [m.id, i]));
  let bestCost = null;
  for (const p of all) {
    if (!bestCost || p.cost[0] < bestCost[0] || (p.cost[0] === bestCost[0] && p.cost[1] < bestCost[1])) {
      bestCost = p.cost;
    }
  }
  const optimal = all.filter((p) => p.cost[0] === bestCost[0] && p.cost[1] === bestCost[1]);
  // canonical = lexicographically smallest vector of (shift, moldIdx) in sorted job order
  optimal.sort((p1, p2) => {
    for (let i = 0; i < p1.assign.length; i++) {
      const a1 = p1.assign[i];
      const a2 = p2.assign[i];
      if (a1.shift !== a2.shift) return a1.shift - a2.shift;
      const d = moldIdx.get(a1.mold) - moldIdx.get(a2.mold);
      if (d !== 0) return d;
    }
    return 0;
  });
  return { cost: bestCost, assign: optimal[0].assign };
}

function normAssign(assign) {
  return assign.map((a) => `${a.job}@${a.shift}:${a.mold}`).join(',');
}

test('tied optima: symmetric molds produce one canonical plan, deterministically', () => {
  const molds = [
    { id: 'MA', life: 100, changeTime: 2 },
    { id: 'MB', life: 100, changeTime: 2 },
  ];
  const shifts = [{ id: 'S1', budget: 100 }];
  const jobs = [
    { id: 'J1', units: 30, eligible: ['MA', 'MB'] },
    { id: 'J2', units: 30, eligible: ['MA', 'MB'] },
  ];
  const results = new Set();
  for (let i = 0; i < 5; i++) {
    const r = solve(jobs, molds, shifts);
    results.add(normAssign(r.assign));
  }
  assert.equal(results.size, 1, 'parallel optima must tie-break to a single plan');
  // canonical: both jobs on shift 0, first mold MA
  assert.equal([...results][0], 'J1@0:MA,J2@0:MA');
});

test('tied optima: input order does not change the chosen plan', () => {
  const molds = [
    { id: 'MA', life: 100, changeTime: 2 },
    { id: 'MB', life: 100, changeTime: 2 },
  ];
  const shifts = [
    { id: 'S1', budget: 60 },
    { id: 'S2', budget: 60 },
  ];
  const jobs = [
    { id: 'J1', units: 30, eligible: ['MB', 'MA'] },
    { id: 'J2', units: 30, eligible: ['MA', 'MB'] },
    { id: 'J3', units: 30, eligible: ['MB'] },
  ];
  const a = solve(jobs, molds, shifts);
  // job array order and per-job eligible order are normalized internally;
  // mold/shift array order defines the fixed tie-break and stays put
  const shuffledJobs = [...jobs].reverse().map((j) => ({ ...j, eligible: [...j.eligible].reverse() }));
  const b = solve(shuffledJobs, molds, shifts);
  assert.equal(normAssign(a.assign), normAssign(b.assign));
});

test('budget boundary: load == budget feasible, budget - 1 infeasible', () => {
  const molds = [{ id: 'M1', life: 1000, changeTime: 1 }];
  const jobs = [
    { id: 'J1', units: 50, eligible: ['M1'] },
    { id: 'J2', units: 50, eligible: ['M1'] },
  ];
  const exact = solve(jobs, molds, [{ id: 'S1', budget: 100 }]);
  assert.ok(exact, 'load exactly at budget must be feasible');
  const over = solve(jobs, molds, [{ id: 'S1', budget: 99 }]);
  assert.equal(over, null, 'one unit over budget must be infeasible');
});

test('mold life boundary: usage == life feasible, life - 1 infeasible', () => {
  const shifts = [{ id: 'S1', budget: 1000 }];
  const jobs = [
    { id: 'J1', units: 60, eligible: ['M1'] },
    { id: 'J2', units: 40, eligible: ['M1'] },
  ];
  assert.ok(solve(jobs, [{ id: 'M1', life: 100, changeTime: 1 }], shifts));
  assert.equal(solve(jobs, [{ id: 'M1', life: 99, changeTime: 1 }], shifts), null);
});

// deterministic PRNG (mulberry32)
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('n<=9 enumeration cross-check: solver matches brute force on random instances', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const rand = rng(seed);
    const n = 1 + Math.floor(rand() * 9); // 1..9 jobs
    const nMolds = n > 6 ? 1 + Math.floor(rand() * 2) : 1 + Math.floor(rand() * 3);
    const nShifts = n > 6 ? 1 + Math.floor(rand() * 2) : 1 + Math.floor(rand() * 3);
    const molds = Array.from({ length: nMolds }, (_, i) => ({
      id: `M${i}`,
      life: 40 + Math.floor(rand() * 120),
      changeTime: 1 + Math.floor(rand() * 5),
    }));
    const shifts = Array.from({ length: nShifts }, (_, i) => ({
      id: `S${i}`,
      budget: 40 + Math.floor(rand() * 120),
    }));
    const jobs = Array.from({ length: n }, (_, i) => {
      const eligible = molds.map((m) => m.id).filter(() => rand() < 0.7);
      if (eligible.length === 0) eligible.push(molds[0].id);
      return { id: `J${i}`, units: 5 + Math.floor(rand() * 30), eligible };
    });
    const got = solve(jobs, molds, shifts);
    const want = canonicalBest(jobs, molds, shifts);
    if (!want) {
      assert.equal(got, null, `seed ${seed}: expected infeasible`);
    } else {
      assert.ok(got, `seed ${seed}: expected feasible`);
      assert.deepEqual(got.cost, want.cost, `seed ${seed}: cost mismatch`);
      assert.equal(normAssign(got.assign), normAssign(want.assign), `seed ${seed}: canonical plan mismatch`);
    }
  }
});
