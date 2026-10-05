'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateModel } = require('../src/model');
const { solve, compareTuples, EPS } = require('../src/solver');
const { bruteForce, checkPlan, totalShed, rng, randomModel } = require('../testlib/brute');

const BIG_BUDGET = 1_000_000;

function modelOf(raw) {
  return validateModel(raw);
}

// --- acceptance 1: enumerate every stage combination on small instances ----
test('matches brute-force feasibility and optimal cost on 3-5 load instances', () => {
  const rand = rng(20261006);
  let feasibleCount = 0;
  let infeasibleCount = 0;
  for (let t = 0; t < 60; t += 1) {
    const loadCount = 3 + Math.floor(rand() * 3); // 3..5 loads
    const raw = randomModel(rand, { loadCount, feederCount: 1 + Math.floor(rand() * 2) });
    const model = modelOf(raw);
    const maxPower = raw.feeders.reduce(
      (sum, f) => sum + f.loads.reduce((s, l) => s + l.power, 0),
      0,
    );
    const gap = Math.floor(rand() * maxPower * 1.2);

    const expected = bruteForce(model, gap);
    const result = solve(model, { gap, budget: BIG_BUDGET });

    if (expected === null) {
      infeasibleCount += 1;
      assert.equal(result.status, 'infeasible', `case ${t}: expected infeasible`);
      assert.ok(result.conflict, 'infeasible result carries a conflict');
    } else {
      feasibleCount += 1;
      assert.equal(result.status, 'optimal', `case ${t}: expected optimal`);
      assert.ok(checkPlan(model, result.plan, gap), `case ${t}: plan must be feasible`);
      assert.ok(totalShed(model, result.plan) >= gap - EPS, `case ${t}: plan meets gap`);
      assert.equal(
        compareTuples(result.cost, expected.tuple),
        0,
        `case ${t}: optimal cost matches brute force`,
      );
    }
  }
  assert.ok(feasibleCount > 0, 'sample covered feasible instances');
  assert.ok(infeasibleCount > 0, 'sample covered infeasible instances');
});

test('prefers shedding lower importance levels first, ties by id', () => {
  const model = modelOf({
    feeders: [{
      id: 'F1',
      capacity: 500,
      loads: [
        { id: 'L1', power: 100, level: 1, maxStage: 2 },
        { id: 'L2', power: 100, level: 3, maxStage: 2 },
      ],
    }],
    interlocks: [],
  });
  const result = solve(model, { gap: 100, budget: BIG_BUDGET });
  assert.equal(result.status, 'optimal');
  // level 1 (L1) must be shed before touching level 3 (L2)
  assert.deepEqual(result.plan, { L1: 2, L2: 0 });
  assert.equal(result.shed, 100);
});

// --- acceptance 2: interlocks make the gap unreachable -> conflict ---------
test('minimal conflict mixes feeder capacity and interlocked loads', () => {
  const raw = {
    feeders: [
      { id: 'F1', capacity: 100, loads: [{ id: 'L1', power: 60, level: 1, maxStage: 1 }] },
      { id: 'F2', capacity: 50, loads: [{ id: 'L2', power: 60, level: 1, maxStage: 1 }] },
      { id: 'F3', capacity: 100, loads: [{ id: 'L3', power: 40, level: 1, maxStage: 1 }] },
    ],
    interlocks: [{ type: 'noshed', load: 'L1' }],
  };
  const model = modelOf(raw);
  const gap = 100;

  // sanity: brute force agrees nothing works
  assert.equal(bruteForce(model, gap), null);

  const result = solve(model, { gap, budget: BIG_BUDGET });
  assert.equal(result.status, 'infeasible');
  const { conflict } = result;
  assert.equal(conflict.kind, 'capacity');
  // max shed = 0 (L1 locked) + min(60, 50 on F2) + 40 = 90 < 100
  assert.ok(Math.abs(conflict.maxShed - 90) < EPS);
  assert.equal(conflict.gap, gap);
  // irreducible core: feeder F2 capacity + noshed interlock on L1
  assert.deepEqual([...conflict.constraints].sort(), ['F2', 'L1']);
  assert.deepEqual(conflict.feeders, ['F2']);
  assert.deepEqual(conflict.loads, ['L1']);
});

test('minimal conflict from pure interlock chains (noshed + together)', () => {
  const raw = {
    feeders: [{
      id: 'F1',
      capacity: 500,
      loads: [
        { id: 'L1', power: 50, level: 1, maxStage: 1 },
        { id: 'L2', power: 60, level: 1, maxStage: 1 },
        { id: 'L3', power: 40, level: 1, maxStage: 1 },
      ],
    }],
    interlocks: [
      { type: 'noshed', load: 'L1' },
      { type: 'noshed', load: 'L3' },
      { type: 'together', loads: ['L2', 'L3'] },
    ],
  };
  const model = modelOf(raw);
  const gap = 100;
  assert.equal(bruteForce(model, gap), null);

  const result = solve(model, { gap, budget: BIG_BUDGET });
  assert.equal(result.status, 'infeasible');
  const { conflict } = result;
  // L3 locked at 0 drags L2 to 0 via the together lock; only L1 (50) can shed.
  assert.ok(Math.abs(conflict.maxShed - 50) < EPS);
  assert.deepEqual([...conflict.constraints].sort(), ['L2+L3', 'L3']);
  assert.deepEqual(conflict.loads, ['L3']);
  assert.deepEqual(conflict.together, ['L2+L3']);
});

test('conflict disappears once the interlock is relaxed', () => {
  const raw = {
    feeders: [{
      id: 'F1',
      capacity: 500,
      loads: [
        { id: 'L1', power: 100, level: 1, maxStage: 1 },
        { id: 'L2', power: 60, level: 1, maxStage: 1 },
      ],
    }],
    interlocks: [{ type: 'noshed', load: 'L1' }],
  };
  const blocked = solve(modelOf(raw), { gap: 100, budget: BIG_BUDGET });
  assert.equal(blocked.status, 'infeasible');
  assert.deepEqual(blocked.conflict.loads, ['L1']);

  const freed = solve(modelOf({ ...raw, interlocks: [] }), { gap: 100, budget: BIG_BUDGET });
  assert.equal(freed.status, 'optimal');
});

// --- acceptance 3: budget exhaustion -> unknown, larger budget -> plan -----
test('small budget yields unknown with pending loads; larger budget yields a plan', () => {
  const raw = {
    feeders: [{
      id: 'F1',
      capacity: 400,
      loads: [
        { id: 'L1', power: 90, level: 1, maxStage: 3 },
        { id: 'L2', power: 80, level: 2, maxStage: 3 },
        { id: 'L3', power: 70, level: 1, maxStage: 2 },
        { id: 'L4', power: 60, level: 3, maxStage: 2 },
        { id: 'L5', power: 50, level: 2, maxStage: 2 },
      ],
    }],
    interlocks: [{ type: 'order', first: 'L2', then: 'L5' }],
  };
  const model = modelOf(raw);
  const gap = 150;

  const starved = solve(model, { gap, budget: 1 });
  assert.equal(starved.status, 'unknown');
  assert.notEqual(starved.status, 'infeasible'); // never report unknown as infeasible
  assert.ok(Array.isArray(starved.pending) && starved.pending.length > 0);
  for (const id of starved.pending) {
    assert.ok(raw.feeders[0].loads.some((l) => l.id === id), `pending id ${id} is a real load`);
  }

  const solved = solve(model, { gap, budget: BIG_BUDGET });
  assert.equal(solved.status, 'optimal');
  assert.ok(checkPlan(model, solved.plan, gap));
  assert.ok(totalShed(model, solved.plan) >= gap - EPS);
  // order interlock respected: L2 sheds no later than L5
  assert.ok(solved.plan.L2 >= solved.plan.L5);

  const expected = bruteForce(model, gap);
  assert.equal(compareTuples(solved.cost, expected.tuple), 0);
});

test('gap of zero keeps every load at stage 0', () => {
  const model = modelOf({
    feeders: [{ id: 'F1', capacity: 10, loads: [{ id: 'L1', power: 50, level: 1, maxStage: 2 }] }],
    interlocks: [],
  });
  const result = solve(model, { gap: 0, budget: BIG_BUDGET });
  assert.equal(result.status, 'optimal');
  assert.deepEqual(result.plan, { L1: 0 });
});
