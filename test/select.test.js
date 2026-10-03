import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobStore } from '../src/store.js';
import { Planner, MAX_CANDIDATES } from '../src/planner.js';
import { PlannerError, E_LIMIT } from '../src/errors.js';

// All test jobs match the filter: phrase once + one qualifying pair, so
// hits=2 and score = 20 - overdue for every job.
function makeStore(specs) {
  const store = new JobStore();
  for (const s of specs) {
    store.add({
      id: s.id,
      description: `低温 固化 ${s.id}-M ${s.id}-E`,
      material: `${s.id}-M`,
      equipment: `${s.id}-E`,
      cost: s.cost,
      overdue: s.overdue,
    });
  }
  return store;
}

// Acceptance 1: independent brute force over ALL subsets (recursive),
// verifying top-k optimality and that every tied optimum is returned.
function bruteForce(items, k, budget) {
  const best = { score: -Infinity, cost: Infinity, sets: [] };
  function walk(i, chosen, cost, score) {
    if (cost > budget || chosen.length > k) return;
    if (i === items.length) {
      if (chosen.length === 0) return;
      if (score > best.score || (score === best.score && cost < best.cost)) {
        best.score = score;
        best.cost = cost;
        best.sets = [chosen.slice().sort()];
      } else if (score === best.score && cost === best.cost) {
        best.sets.push(chosen.slice().sort());
      }
      return;
    }
    walk(i + 1, chosen, cost, score);
    chosen.push(items[i].id);
    walk(i + 1, chosen, cost + items[i].cost, score + items[i].score);
    chosen.pop();
  }
  walk(0, [], 0, 0);
  return best;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('acceptance 1: select matches exhaustive subset enumeration (randomized)', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rnd = mulberry32(seed);
    const n = 1 + Math.floor(rnd() * 8); // 1..8 jobs
    const specs = [];
    for (let i = 0; i < n; i++) {
      specs.push({
        id: `J${i}`,
        cost: Math.floor(rnd() * 30),
        overdue: Math.floor(rnd() * 25), // score can go negative
      });
    }
    const k = 1 + Math.floor(rnd() * 4);
    const budget = Math.floor(rnd() * 60);
    const planner = new Planner(makeStore(specs));
    const result = planner.select({ k, budget });
    const items = specs.map((s) => ({ id: s.id, cost: s.cost, score: 20 - s.overdue }));
    const expected = bruteForce(items, k, budget);
    if (expected.sets.length === 0) {
      assert.equal(result.status, 'OVER_BUDGET', `seed=${seed}`);
      continue;
    }
    const gotSets = result.optima.map((o) => o.ids).sort();
    const wantSets = expected.sets.map((s) => s.slice().sort()).sort();
    assert.deepEqual(gotSets, wantSets, `seed=${seed} all tied optima returned`);
    assert.equal(result.optima[0].score, expected.score, `seed=${seed} score`);
    assert.equal(result.optima[0].cost, expected.cost, `seed=${seed} cost`);
    assert.equal(result.status, wantSets.length > 1 ? 'TIE' : 'OK', `seed=${seed} status`);
  }
});

test('acceptance 1b: handcrafted tie returns every tied optimum, ids ascending', () => {
  // scores: J1=J2=15, J3=20. {J1,J3} and {J2,J3} tie at k=2, budget 15.
  const store = makeStore([
    { id: 'J1', cost: 10, overdue: 5 },
    { id: 'J2', cost: 10, overdue: 5 },
    { id: 'J3', cost: 5, overdue: 0 },
  ]);
  const planner = new Planner(store);
  const r = planner.select({ k: 2, budget: 15 });
  assert.equal(r.status, 'TIE');
  assert.deepEqual(r.optima.map((o) => o.ids), [['J1', 'J3'], ['J2', 'J3']]);
  assert.equal(r.optima[0].score, 35);
  assert.equal(r.optima[0].remaining, 0);
});

test('acceptance 2: budget off-by-one boundary', () => {
  const store = makeStore([{ id: 'J1', cost: 50, overdue: 0 }]);
  const planner = new Planner(store);
  assert.equal(planner.select({ k: 1, budget: 49 }).status, 'OVER_BUDGET');
  const at = planner.select({ k: 1, budget: 50 });
  assert.equal(at.status, 'OK');
  assert.deepEqual(at.optima[0].ids, ['J1']);
  assert.equal(at.optima[0].remaining, 0);
});

test('acceptance 4: EMPTY vs OVER_BUDGET are distinct states', () => {
  const emptyPlanner = new Planner(makeStore([{ id: 'J1', cost: 1, overdue: 99 }]));
  // make it non-matching: no candidates at all
  const s2 = new JobStore();
  s2.add({ id: 'X', description: '高温 固化 X-M X-E', material: 'X-M', equipment: 'X-E', cost: 1, overdue: 0 });
  assert.equal(new Planner(s2).select({ k: 1, budget: 100 }).status, 'EMPTY');
  // matching candidate exists but exceeds budget
  assert.equal(emptyPlanner.select({ k: 1, budget: 0 }).status, 'OVER_BUDGET');
});

test('E_LIMIT: invalid k/budget and enumeration cap', () => {
  const planner = new Planner(makeStore([{ id: 'J1', cost: 1, overdue: 0 }]));
  assert.throws(() => planner.select({ k: 0, budget: 10 }), (e) => e instanceof PlannerError && e.code === E_LIMIT);
  assert.throws(() => planner.select({ k: 1, budget: -1 }), (e) => e.code === E_LIMIT);
  const many = [];
  for (let i = 0; i < MAX_CANDIDATES + 1; i++) many.push({ id: `J${i}`, cost: 1, overdue: 0 });
  const big = new Planner(makeStore(many));
  assert.throws(() => big.select({ k: 2, budget: 10 }), (e) => e.code === E_LIMIT);
});
