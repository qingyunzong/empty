import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enumerateJointPlans, scheduleJoint, canonicalPlan, Store } from '../src/index.js';

// Independent DFS reference: enumerates every assignment of one plan per
// order, keeps those whose joint (material, day) usage fits the budgets,
// and returns the tuple set plus the lexicographically smallest tuple.
function dfsReference(orders, budgets) {
  const budgetOf = new Map(budgets.map((b) => [`${b.material} ${b.day}`, b.amount]));
  const tuples = [];
  const chosen = new Array(orders.length);

  function jointUsageFits(upTo) {
    const totals = new Map();
    for (let i = 0; i <= upTo; i += 1) {
      for (const a of chosen[i]) {
        const k = `${a.material} ${a.day}`;
        totals.set(k, (totals.get(k) ?? 0) + a.amount);
      }
    }
    for (const [k, v] of totals) {
      if (v > (budgetOf.get(k) ?? 0)) return false;
    }
    return true;
  }

  function dfs(i) {
    if (i === orders.length) {
      tuples.push(chosen.map((plan) => canonicalPlan(plan)));
      return;
    }
    for (const plan of orders[i].plans) {
      chosen[i] = plan;
      if (jointUsageFits(i)) dfs(i + 1);
    }
  }
  dfs(0);

  const keys = tuples.map((t) => t.join(''));
  const optimum = keys.length ? tuples[keys.indexOf([...keys].sort()[0])] : null;
  return { tuples, optimum };
}

// Deterministic pseudo-random generator so failures are reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x80000000;
  };
}

function randomInstance(rand, orderCount) {
  const materials = ['steel', 'hours'];
  const machines = ['m1', 'm2'];
  const budgets = [];
  for (const material of materials) {
    for (let day = 1; day <= 2; day += 1) {
      budgets.push({ material, day, amount: 20 + Math.floor(rand() * 60) });
    }
  }
  const orders = [];
  for (let o = 0; o < orderCount; o += 1) {
    const planCount = 1 + Math.floor(rand() * 3);
    const plans = [];
    for (let p = 0; p < planCount; p += 1) {
      const allocCount = 1 + Math.floor(rand() * 2);
      const plan = [];
      for (let a = 0; a < allocCount; a += 1) {
        plan.push({
          machine: machines[Math.floor(rand() * machines.length)],
          day: 1 + Math.floor(rand() * 2),
          material: materials[Math.floor(rand() * materials.length)],
          amount: Math.floor(rand() * 40),
        });
      }
      plans.push(plan);
    }
    orders.push({ id: `o${o}`, plans });
  }
  return { orders, budgets };
}

test('library enumeration matches independent DFS reference for <=3 orders (seeded sweep)', () => {
  for (let seed = 1; seed <= 60; seed += 1) {
    const rand = rng(seed);
    const orderCount = 1 + Math.floor(rand() * 3); // 1..3 orders
    const { orders, budgets } = randomInstance(rand, orderCount);

    const expected = dfsReference(orders, budgets);
    const actual = enumerateJointPlans(orders, budgets);

    const actualKeys = actual.map((t) => t.join('')).sort();
    const expectedKeys = expected.tuples.map((t) => t.join('')).sort();
    assert.deepEqual(actualKeys, expectedKeys, `seed=${seed} enumeration mismatch`);

    if (expected.optimum) {
      const store = new Store();
      for (const b of budgets) store.setBudget(b.material, b.day, b.amount);
      const joint = scheduleJoint(store, orders, budgets);
      assert.deepEqual(
        joint.assignment.map((a) => a.plan),
        expected.optimum,
        `seed=${seed} optimum mismatch`,
      );
    } else {
      const store = new Store();
      for (const b of budgets) store.setBudget(b.material, b.day, b.amount);
      assert.throws(() => scheduleJoint(store, orders, budgets), (err) => err.code === 'E_BUDGET');
    }
  }
});

test('hand-checkable case: enumeration and optimum for 2 orders', () => {
  const budgets = [{ material: 'steel', day: 1, amount: 10 }];
  const orders = [
    { id: 'o1', plans: [
      [{ machine: 'm1', day: 1, material: 'steel', amount: 6 }],
      [{ machine: 'm2', day: 1, material: 'steel', amount: 4 }],
    ] },
    { id: 'o2', plans: [
      [{ machine: 'm1', day: 1, material: 'steel', amount: 5 }],
      [{ machine: 'm2', day: 1, material: 'steel', amount: 4 }],
    ] },
  ];
  const all = enumerateJointPlans(orders, budgets);
  // (6,5) exceeds 10; the other three combinations are feasible.
  assert.equal(all.length, 3);
  const store = new Store();
  store.setBudget('steel', 1, 10);
  const joint = scheduleJoint(store, orders, budgets);
  // Canonical JSON sorts keys first, so the tuple join is ordered by the
  // "amount" field before "machine": the smallest tuple is o1->m2(4)
  // paired with o2->m2(4).
  assert.equal(joint.assignment[0].plan, canonicalPlan(orders[0].plans[1]));
  assert.equal(joint.assignment[1].plan, canonicalPlan(orders[1].plans[1]));
});
