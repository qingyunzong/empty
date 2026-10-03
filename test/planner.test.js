import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWave, canSchedule, minimalCut, aggregateRoute } from '../src/planner.js';

// Independent brute-force reference: enumerates every (route, shuttle) choice
// and minimizes (makespan, energy, path signature, assignment vector).
function bruteForce(tasks, shuttles, budget) {
  const T = [...tasks].sort((a, b) => (a.id < b.id ? -1 : 1));
  const S = [...shuttles].sort((a, b) => (a.id < b.id ? -1 : 1));
  const aggs = T.map((t) => t.routes.map(aggregateRoute));
  const chosen = new Array(T.length);
  let best = null;

  const cmpPath = (a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return a.length - b.length;
  };
  const cmpSig = (a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = cmpPath(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  };
  const isBetter = (c, b) => {
    if (c.makespan !== b.makespan) return c.makespan < b.makespan;
    if (c.energy !== b.energy) return c.energy < b.energy;
    const s = cmpSig(c.signature, b.signature);
    if (s !== 0) return s < 0;
    for (let i = 0; i < c.vec.length; i++) if (c.vec[i] !== b.vec[i]) return c.vec[i] < b.vec[i];
    return false;
  };

  function dfs(i, loads, used, total) {
    if (i === T.length) {
      const cand = {
        makespan: loads.length ? Math.max(...loads) : 0,
        energy: total,
        signature: chosen.map((c, k) => aggs[k][c[1]].path),
        vec: chosen.flatMap((c) => [c[0], c[1]]),
        assignments: chosen.map((c, k) => ({ task: T[k].id, route: c[1], shuttle: S[c[0]].id })),
      };
      if (!best || isBetter(cand, best)) best = cand;
      return;
    }
    for (let s = 0; s < S.length; s++) {
      for (let r = 0; r < aggs[i].length; r++) {
        const ag = aggs[i][r];
        if (used[s] + ag.energy > S[s].battery || total + ag.energy > budget) continue;
        used[s] += ag.energy;
        loads[s] += ag.duration;
        chosen[i] = [s, r];
        dfs(i + 1, loads, used, total + ag.energy);
        used[s] -= ag.energy;
        loads[s] -= ag.duration;
      }
    }
  }
  dfs(0, new Array(S.length).fill(0), new Array(S.length).fill(0), 0);
  return best;
}

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

function randomInstance(rand) {
  const lanes = ['L1', 'L2', 'L3'];
  const ri = (n) => Math.floor(rand() * n);
  const nTasks = 1 + ri(5);
  const tasks = [];
  for (let i = 0; i < nTasks; i++) {
    const nRoutes = 1 + ri(3);
    const routes = [];
    for (let r = 0; r < nRoutes; r++) {
      const nMoves = 1 + ri(2);
      const moves = [];
      for (let m = 0; m < nMoves; m++) {
        moves.push({
          from: `P${ri(4)}`,
          to: `P${ri(4)}`,
          lane: lanes[ri(3)],
          energy: ri(10),
          duration: ri(10),
        });
      }
      routes.push({ moves });
    }
    tasks.push({ id: `t${i}`, routes });
  }
  const nShuttles = 1 + ri(3);
  const shuttles = [];
  for (let i = 0; i < nShuttles; i++) shuttles.push({ id: `s${i}`, battery: ri(26) });
  const budget = ri(41);
  return { tasks, shuttles, budget };
}

test('acceptance 1: planner matches exhaustive optimum on small waves (incl. ties)', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const rand = mulberry32(seed);
    const { tasks, shuttles, budget } = randomInstance(rand);
    const got = planWave({ tasks, shuttles, budget });
    const want = bruteForce(tasks, shuttles, budget);
    if (want === null) {
      assert.equal(got, null, `seed ${seed}: expected infeasible`);
    } else {
      assert.ok(got, `seed ${seed}: expected feasible`);
      assert.equal(got.makespan, want.makespan, `seed ${seed} makespan`);
      assert.equal(got.energy, want.energy, `seed ${seed} energy`);
      assert.deepEqual(got.assignments, want.assignments, `seed ${seed} assignments`);
    }
  }
});

test('tie on makespan and energy breaks by path lexicographic order', () => {
  const tasks = [
    {
      id: 't1',
      routes: [
        { moves: [{ from: 'A', to: 'B', lane: 'L2', energy: 5, duration: 5 }] },
        { moves: [{ from: 'A', to: 'B', lane: 'L1', energy: 5, duration: 5 }] },
      ],
    },
    { id: 't2', routes: [{ moves: [{ from: 'C', to: 'D', lane: 'L1', energy: 5, duration: 5 }] }] },
  ];
  const plan = planWave({ tasks, shuttles: [{ id: 's1', battery: 10 }], budget: 10 });
  assert.equal(plan.assignments.find((a) => a.task === 't1').route, 1);
  assert.deepEqual(plan.signature, [['L1'], ['L1']]);
});

test('tie on makespan breaks by lower energy', () => {
  const tasks = [
    {
      id: 't1',
      routes: [
        { moves: [{ from: 'A', to: 'B', lane: 'L1', energy: 5, duration: 5 }] },
        { moves: [{ from: 'A', to: 'B', lane: 'L1', energy: 3, duration: 5 }] },
      ],
    },
  ];
  const plan = planWave({ tasks, shuttles: [{ id: 's1', battery: 10 }], budget: 10 });
  assert.equal(plan.energy, 3);
  assert.equal(plan.assignments[0].route, 1);
});

test('tie on identical shuttles resolves deterministically by shuttle id', () => {
  const tasks = [
    { id: 't1', routes: [{ moves: [{ from: 'A', to: 'B', lane: 'L1', energy: 4, duration: 4 }] }] },
  ];
  const shuttles = [
    { id: 's1', battery: 10 },
    { id: 's2', battery: 10 },
  ];
  const plan = planWave({ tasks, shuttles, budget: 10 });
  assert.equal(plan.assignments[0].shuttle, 's1');
});

test('makespan prefers balancing work across shuttles', () => {
  const tasks = [
    { id: 't1', routes: [{ moves: [{ from: 'A', to: 'B', lane: 'L1', energy: 3, duration: 10 }] }] },
    { id: 't2', routes: [{ moves: [{ from: 'C', to: 'D', lane: 'L2', energy: 3, duration: 1 }] }] },
  ];
  const shuttles = [
    { id: 's1', battery: 10 },
    { id: 's2', battery: 10 },
  ];
  const plan = planWave({ tasks, shuttles, budget: 10 });
  assert.equal(plan.makespan, 10);
  assert.notEqual(plan.assignments[0].shuttle, plan.assignments[1].shuttle);
});

test('acceptance 4: budget exactly equal to demand is feasible', () => {
  const tasks = [
    { id: 't1', routes: [{ moves: [{ from: 'A', to: 'B', lane: 'L1', energy: 4, duration: 4 }] }] },
    { id: 't2', routes: [{ moves: [{ from: 'C', to: 'D', lane: 'L2', energy: 6, duration: 3 }] }] },
  ];
  const shuttles = [{ id: 's1', battery: 10 }];
  const plan = planWave({ tasks, shuttles, budget: 10 });
  assert.ok(plan);
  assert.equal(plan.energy, 10);
  assert.equal(planWave({ tasks, shuttles, budget: 9 }), null);
});

test('per-shuttle battery is a hard constraint even when budget suffices', () => {
  const tasks = [
    { id: 't1', routes: [{ moves: [{ from: 'A', to: 'B', lane: 'L1', energy: 6, duration: 1 }] }] },
  ];
  assert.equal(planWave({ tasks, shuttles: [{ id: 's1', battery: 5 }], budget: 100 }), null);
  assert.ok(planWave({ tasks, shuttles: [{ id: 's1', battery: 6 }], budget: 100 }));
});

test('minimal cut: single task suffices, picked by least removed energy then id', () => {
  const mk = (id, e) => ({
    id,
    routes: [{ moves: [{ from: 'A', to: 'B', lane: 'L1', energy: e, duration: 1 }] }],
  });
  const shuttles = [{ id: 's1', battery: 1000 }];

  // demand 60, budget 35: removing t3 (30) leaves 30 <= 35; no cheaper single cut works
  let mc = minimalCut([mk('t1', 10), mk('t2', 20), mk('t3', 30)], shuttles, 35);
  assert.deepEqual(mc.cut, ['t3']);
  assert.equal(mc.deficit, 25);

  // demand 45, budget 25: t1 (20) and t2 (20) both suffice, tie on energy -> lexicographic
  mc = minimalCut([mk('t1', 20), mk('t2', 20), mk('t3', 5)], shuttles, 25);
  assert.deepEqual(mc.cut, ['t1']);

  // demand 90, budget 40: minimum cardinality is 2, least removed energy wins
  mc = minimalCut([mk('t1', 30), mk('t2', 40), mk('t3', 20)], shuttles, 40);
  assert.deepEqual(mc.cut, ['t1', 't3']);
  assert.equal(mc.removedEnergy, 50);
});

test('minimal cut respects per-shuttle battery, not just total energy', () => {
  const mk = (id, e) => ({
    id,
    routes: [{ moves: [{ from: 'A', to: 'B', lane: 'L1', energy: e, duration: 1 }] }],
  });
  // two shuttles of battery 6 cannot hold two energy-6 tasks plus anything;
  // budget is ample, so the cut is driven by battery packing
  const shuttles = [
    { id: 's1', battery: 6 },
    { id: 's2', battery: 6 },
  ];
  const mc = minimalCut([mk('t1', 6), mk('t2', 6), mk('t3', 6)], shuttles, 1000);
  assert.deepEqual(mc.cut, ['t1']);
});

test('canSchedule agrees with planWave feasibility', () => {
  for (let seed = 500; seed < 560; seed++) {
    const rand = mulberry32(seed);
    const { tasks, shuttles, budget } = randomInstance(rand);
    assert.equal(canSchedule(tasks, shuttles, budget), planWave({ tasks, shuttles, budget }) !== null);
  }
});

test('reuse hints are honored on exact ties', () => {
  const tasks = [
    {
      id: 't1',
      routes: [
        { moves: [{ from: 'A', to: 'B', lane: 'L1', energy: 5, duration: 5 }] },
        { moves: [{ from: 'A', to: 'B', lane: 'L1', energy: 5, duration: 5 }] },
      ],
    },
  ];
  const shuttles = [{ id: 's1', battery: 10 }];
  const plain = planWave({ tasks, shuttles, budget: 10 });
  assert.equal(plain.assignments[0].route, 0);
  const reused = planWave({ tasks, shuttles, budget: 10, reuseHints: new Set(['t1:1']) });
  assert.equal(reused.assignments[0].route, 1);
  assert.equal(reused.energy, plain.energy);
});
