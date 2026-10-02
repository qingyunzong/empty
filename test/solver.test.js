import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateProblem } from '../src/model.js';
import { solve } from '../src/solver.js';
import { bruteForceReference, bruteForceWithCrews } from '../test-utils/brute.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const IDS = 'ABCDEFGH'.split('');

// Random acyclic instance: edges only from lower to higher index.
function randomInstance(rand, { n, maxModes = 3, withParts = true, tightBudget = false }) {
  const partIds = withParts ? ['p0', 'p1'].slice(0, 1 + Math.floor(rand() * 2)) : [];
  const tasks = [];
  for (let i = 0; i < n; i++) {
    const deps = [];
    for (let j = 0; j < i; j++) {
      if (rand() < 0.35) deps.push(IDS[j]);
    }
    const mCount = 1 + Math.floor(rand() * maxModes);
    const modes = [];
    for (let m = 0; m < mCount; m++) {
      const parts = {};
      for (const p of partIds) {
        if (rand() < 0.4) parts[p] = 1 + Math.floor(rand() * 2);
      }
      modes.push({ duration: 1 + Math.floor(rand() * 6), cost: 1 + Math.floor(rand() * 10), parts });
    }
    tasks.push({ id: IDS[i], deps, modes });
  }
  const parts = {};
  for (const p of partIds) parts[p] = 1 + Math.floor(rand() * 3);
  const minCost = tasks.reduce((acc, t) => acc + Math.min(...t.modes.map((m) => m.cost)), 0);
  const budget = tightBudget
    ? Math.max(0, minCost - 1 + Math.floor(rand() * 4))
    : minCost + Math.floor(rand() * 15);
  return { budget, crews: 2, parts, tasks };
}

function tupleOf(result) {
  if (result.status !== 'optimal') return { status: result.status };
  return {
    status: 'optimal',
    downtime: result.downtime,
    cost: result.cost,
    sequence: result.sequence,
  };
}

test('handcrafted: chain, parallel, diamond match brute force', () => {
  const instances = [
    {
      budget: 50,
      tasks: [
        { id: 'A', modes: [{ duration: 3, cost: 2 }, { duration: 1, cost: 6 }] },
        { id: 'B', deps: ['A'], modes: [{ duration: 2, cost: 2 }, { duration: 1, cost: 5 }] },
        { id: 'C', deps: ['B'], modes: [{ duration: 2, cost: 3 }] },
      ],
    },
    {
      budget: 8,
      tasks: [
        { id: 'A', modes: [{ duration: 5, cost: 1 }, { duration: 2, cost: 4 }] },
        { id: 'B', modes: [{ duration: 4, cost: 1 }, { duration: 2, cost: 4 }] },
        { id: 'C', modes: [{ duration: 3, cost: 1 }, { duration: 1, cost: 4 }] },
        { id: 'D', modes: [{ duration: 2, cost: 1 }] },
      ],
    },
    {
      budget: 30,
      parts: { valve: 1 },
      tasks: [
        { id: 'A', modes: [{ duration: 2, cost: 2, parts: { valve: 1 } }, { duration: 4, cost: 1 }] },
        { id: 'B', deps: ['A'], modes: [{ duration: 2, cost: 2, parts: { valve: 1 } }, { duration: 5, cost: 1 }] },
        { id: 'C', deps: ['A'], modes: [{ duration: 3, cost: 2 }] },
        { id: 'D', deps: ['B', 'C'], modes: [{ duration: 1, cost: 2 }, { duration: 1, cost: 1 }] },
      ],
    },
  ];
  for (const input of instances) {
    const state = validateProblem(input);
    const got = tupleOf(solve(state));
    const want = tupleOf(bruteForceReference(state));
    assert.deepEqual(got, want, `mismatch for ${JSON.stringify(input)}`);
  }
});

test('random instances (<=8 tasks) match brute force over mode combos x topo orders', () => {
  const rand = mulberry32(20261003);
  for (let t = 0; t < 40; t++) {
    const n = 2 + Math.floor(rand() * 7); // 2..8 tasks
    const tightBudget = t % 4 === 3;
    const input = randomInstance(rand, { n, tightBudget });
    const state = validateProblem(input);
    const got = tupleOf(solve(state));
    const want = tupleOf(bruteForceReference(state));
    assert.deepEqual(got, want, `mismatch on instance ${t}: ${JSON.stringify(input)}`);
  }
});

test('random small instances (<=6 tasks) also match crew-assignment brute force', () => {
  const rand = mulberry32(777);
  for (let t = 0; t < 12; t++) {
    const n = 2 + Math.floor(rand() * 5); // 2..6 tasks
    const input = randomInstance(rand, { n, maxModes: 2 });
    const state = validateProblem(input);
    const got = tupleOf(solve(state));
    const want = tupleOf(bruteForceWithCrews(state));
    assert.deepEqual(got, want, `mismatch on crew-enumeration instance ${t}`);
  }
});

test('infeasible when budget below minimum attainable cost', () => {
  const state = validateProblem({
    budget: 2,
    tasks: [
      { id: 'A', modes: [{ duration: 1, cost: 2 }] },
      { id: 'B', modes: [{ duration: 1, cost: 3 }] },
    ],
  });
  const r = solve(state);
  assert.equal(r.status, 'infeasible');
  assert.equal(r.violations[0].code, 'BUDGET_EXCEEDED');
  assert.equal(r.violations[0].minCost, 5);
});

test('infeasible when spare parts are insufficient for every mode choice', () => {
  const state = validateProblem({
    budget: 100,
    parts: { valve: 1 },
    tasks: [
      { id: 'A', modes: [{ duration: 1, cost: 1, parts: { valve: 1 } }] },
      { id: 'B', modes: [{ duration: 1, cost: 1, parts: { valve: 1 } }] },
    ],
  });
  const r = solve(state);
  assert.equal(r.status, 'infeasible');
  assert.ok(r.violations.some((v) => v.code === 'PART_SHORTAGE' && v.part === 'valve'));
});

test('ties are reproduced objectively regardless of input ordering', () => {
  const base = {
    budget: 20,
    parts: { valve: 2, filter: 1 },
    tasks: [
      { id: 'A', modes: [{ duration: 2, cost: 2 }, { duration: 2, cost: 3 }] },
      { id: 'B', modes: [{ duration: 2, cost: 2 }, { duration: 2, cost: 3 }] },
      { id: 'C', deps: ['A'], modes: [{ duration: 1, cost: 1, parts: { valve: 1 } }] },
      { id: 'D', deps: ['B'], modes: [{ duration: 1, cost: 1, parts: { filter: 1 } }] },
      { id: 'E', modes: [{ duration: 3, cost: 2 }] },
    ],
  };
  const shuffled = {
    parts: { filter: 1, valve: 2 },
    tasks: [...base.tasks].reverse(),
    budget: 20,
  };
  const r1 = solve(validateProblem(base));
  const r2 = solve(validateProblem(shuffled));
  assert.equal(r1.status, 'optimal');
  assert.deepEqual(tupleOf(r2), tupleOf(r1));
  assert.deepEqual(r2.intervals, r1.intervals);
});

test('certificate reports exhaustive exact method and optimum', () => {
  const state = validateProblem({
    budget: 10,
    tasks: [{ id: 'A', modes: [{ duration: 1, cost: 1 }, { duration: 2, cost: 0 }] }],
  });
  const r = solve(state);
  assert.equal(r.certificate.method, 'exact-branch-and-bound');
  assert.equal(r.certificate.deterministic, true);
  assert.deepEqual(r.certificate.optimum, { downtime: 1, cost: 1, sequence: ['A'] });
  assert.ok(r.certificate.modeAssignments.feasible >= 1);
});
