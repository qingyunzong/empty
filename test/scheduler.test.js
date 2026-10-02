'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Scheduler, SchedError } = require('../src/scheduler');
const { MVCCStore } = require('../src/mvcc');
const { canonicalJSON, sha256, normalizePlan, compareCanonical } = require('../src/canonical');
const { enumerateFeasibleAssignments, selectOptimalAssignment } = require('../src/enumerate');

const planA = [{ machine: 'M1', day: 1, material: 'steel', amount: 80 }];
const planB = [{ machine: 'M2', day: 1, material: 'steel', amount: 80 }];

test('acceptance 1: lexicographically smallest feasible plan wins, certificate lists compared hashes', () => {
  const s = new Scheduler();
  s.setBudget('steel', 1, 100);
  s.addOrder('W1', [planB, planA]); // insertion order must not matter

  const { certificate } = s.scheduleOrder('W1');

  assert.deepEqual(certificate.chosen.plan, normalizePlan(planA));
  assert.equal(certificate.chosen.hash, sha256(normalizePlan(planA)));
  // certificate contains hashes of all compared candidates, including B
  const comparedHashes = certificate.compared.map((c) => c.hash);
  assert.ok(comparedHashes.includes(sha256(normalizePlan(planB))));
  assert.ok(comparedHashes.includes(sha256(normalizePlan(planA))));
  assert.equal(certificate.compared.length, 2);
  assert.ok(certificate.compared.every((c) => c.feasible));
  // compared list is sorted by canonical JSON
  const canonicals = certificate.compared.map((c) => canonicalJSON(c.plan));
  assert.deepEqual(canonicals, [...canonicals].sort());
  // budget bookkeeping: 80 of 100 used
  assert.deepEqual(certificate.budgets, [
    { material: 'steel', day: 1, amount: 80, limit: 100, usedBefore: 0, usedAfter: 80 },
  ]);
});

test('acceptance 2: concurrent transactions 60+60 over budget 100 -> one E_BUDGET; 50+50 both commit', () => {
  // 60 + 60 = 120 > 100
  {
    const s = new Scheduler();
    s.setBudget('steel', 1, 100);
    s.addOrder('W1', [[{ machine: 'M1', day: 1, material: 'steel', amount: 60 }]]);
    s.addOrder('W2', [[{ machine: 'M1', day: 1, material: 'steel', amount: 60 }]]);

    const t1 = s.begin();
    const t2 = s.begin();
    t1.stageOrder('W1');
    t2.stageOrder('W2'); // both feasible under their shared snapshot
    t1.commit();
    assert.throws(
      () => t2.commit(),
      (err) => err instanceof SchedError && err.code === 'E_BUDGET'
        && err.details.material === 'steel' && err.details.total === 120 && err.details.limit === 100,
    );
    assert.equal(s.committedUsage('steel', 1), 60);
  }
  // 50 + 50 = 100 <= 100
  {
    const s = new Scheduler();
    s.setBudget('steel', 1, 100);
    s.addOrder('W1', [[{ machine: 'M1', day: 1, material: 'steel', amount: 50 }]]);
    s.addOrder('W2', [[{ machine: 'M1', day: 1, material: 'steel', amount: 50 }]]);

    const t1 = s.begin();
    const t2 = s.begin();
    t1.stageOrder('W1');
    t2.stageOrder('W2');
    t1.commit();
    t2.commit();
    assert.equal(s.committedUsage('steel', 1), 100);
    assert.equal(s.getOrder('W1').status, 'scheduled');
    assert.equal(s.getOrder('W2').status, 'scheduled');
  }
});

test('acceptance 3: exact budget use succeeds, +0 succeeds, +1 fails with E_BUDGET', () => {
  const s = new Scheduler();
  s.setBudget('steel', 1, 100);
  s.addOrder('W-full', [[{ machine: 'M1', day: 1, material: 'steel', amount: 100 }]]);
  s.addOrder('W-zero', [[{ machine: 'M1', day: 1, material: 'steel', amount: 0 }]]);
  s.addOrder('W-one', [[{ machine: 'M1', day: 1, material: 'steel', amount: 1 }]]);

  const full = s.scheduleOrder('W-full'); // exactly exhausts the budget
  assert.equal(full.certificate.budgets[0].usedAfter, 100);

  const zero = s.scheduleOrder('W-zero'); // allocating 0 more is fine
  assert.equal(zero.certificate.budgets[0].usedAfter, 100);

  assert.throws(
    () => s.scheduleOrder('W-one'),
    (err) => err.code === 'E_BUDGET' && err.details.orderId === 'W-one',
  );
  assert.equal(s.committedUsage('steel', 1), 100);
});

test('snapshot isolation: a transaction reads its begin snapshot, not later commits', () => {
  const store = new MVCCStore();
  const w = store.begin();
  w.put('k', 'v1');
  w.commit();

  const reader = store.begin();
  const writer = store.begin();
  writer.put('k', 'v2');
  writer.commit();

  assert.equal(reader.get('k'), 'v1');
  assert.equal(store.latest('k'), 'v2');
});

test('commit validation failure rolls back writes and index entries', () => {
  const s = new Scheduler();
  s.setBudget('steel', 1, 10);
  s.addOrder('W1', [[{ machine: 'M1', day: 1, material: 'steel', amount: 8 }]]);
  s.addOrder('W2', [[{ machine: 'M1', day: 1, material: 'steel', amount: 8 }]]);
  const t1 = s.begin();
  const t2 = s.begin();
  t1.stageOrder('W1');
  t2.stageOrder('W2');
  t1.commit();
  assert.throws(() => t2.commit(), (err) => err.code === 'E_BUDGET');
  // nothing leaked from the aborted transaction
  assert.equal(s.committedUsage('steel', 1), 8);
  assert.equal(s.getOrder('W2').status, 'pending');
  assert.equal(s.allocations().length, 1);
});

test('deterministic selection is independent of plan insertion order', () => {
  const plans = [
    [{ machine: 'M3', day: 1, material: 'steel', amount: 10 }],
    [{ machine: 'M1', day: 1, material: 'steel', amount: 10 }],
    [{ machine: 'M2', day: 1, material: 'steel', amount: 10 }],
  ];
  const chosen = [];
  for (const perm of [[0, 1, 2], [2, 1, 0], [1, 2, 0]]) {
    const s = new Scheduler();
    s.setBudget('steel', 1, 100);
    s.addOrder('W', perm.map((i) => plans[i]));
    chosen.push(canonicalJSON(s.scheduleOrder('W').certificate.chosen.plan));
  }
  assert.ok(chosen.every((c) => c === chosen[0]));
  assert.deepEqual(JSON.parse(chosen[0]), normalizePlan(plans[1]));
});

test('plans infeasible under the snapshot are excluded; no feasible plan -> E_BUDGET', () => {
  const s = new Scheduler();
  s.setBudget('steel', 1, 100);
  s.addOrder('W', [
    [{ machine: 'M1', day: 1, material: 'steel', amount: 150 }],
    [{ machine: 'M2', day: 1, material: 'steel', amount: 50 }],
  ]);
  const { certificate } = s.scheduleOrder('W');
  assert.deepEqual(certificate.chosen.plan, normalizePlan([{ machine: 'M2', day: 1, material: 'steel', amount: 50 }]));
  assert.equal(certificate.compared.find((c) => !c.feasible).hash,
    sha256(normalizePlan([{ machine: 'M1', day: 1, material: 'steel', amount: 150 }])));

  const s2 = new Scheduler();
  s2.setBudget('steel', 1, 10);
  s2.addOrder('W', [[{ machine: 'M1', day: 1, material: 'steel', amount: 11 }]]);
  assert.throws(() => s2.scheduleOrder('W'), (err) => err.code === 'E_BUDGET');
});

// Naive cartesian-product reference (no pruning) used to cross-check the DFS enumerator.
function naiveEnumerate(orders, budgets) {
  const limits = new Map(budgets.map((b) => [`${b.material}|${b.day}`, b.limit]));
  const out = [];
  const picked = [];
  function rec(i) {
    if (i === orders.length) {
      const usage = new Map();
      for (const p of picked) {
        for (const a of p.plan) {
          const key = `${a.material}|${a.day}`;
          usage.set(key, (usage.get(key) ?? 0) + a.amount);
        }
      }
      for (const [key, v] of usage) {
        if (v > (limits.get(key) ?? 0)) return;
      }
      out.push(picked.map((p) => ({ orderId: p.orderId, plan: normalizePlan(p.plan) })));
      return;
    }
    for (const plan of orders[i].plans) {
      picked.push({ orderId: orders[i].id, plan });
      rec(i + 1);
      picked.pop();
    }
  }
  rec(0);
  return out;
}

test('acceptance 3 (enumeration): DFS enumerator matches naive exhaustive reference for <=3 orders', () => {
  const budgets = [
    { material: 'steel', day: 1, limit: 100 },
    { material: 'hours', day: 1, limit: 40 },
  ];
  const orders = [
    {
      id: 'W1',
      plans: [
        [{ machine: 'M1', day: 1, material: 'steel', amount: 60 }],
        [{ machine: 'M2', day: 1, material: 'steel', amount: 40 }, { machine: 'M2', day: 1, material: 'hours', amount: 20 }],
      ],
    },
    {
      id: 'W2',
      plans: [
        [{ machine: 'M1', day: 1, material: 'steel', amount: 50 }],
        [{ machine: 'M3', day: 1, material: 'hours', amount: 30 }],
      ],
    },
    {
      id: 'W3',
      plans: [
        [{ machine: 'M2', day: 1, material: 'steel', amount: 70 }],
        [{ machine: 'M1', day: 1, material: 'hours', amount: 10 }],
        [{ machine: 'M1', day: 1, material: 'steel', amount: 10 }, { machine: 'M1', day: 1, material: 'hours', amount: 10 }],
      ],
    },
  ];

  const actual = enumerateFeasibleAssignments(orders, budgets).map(canonicalJSON).sort();
  const expected = naiveEnumerate(orders, budgets).map(canonicalJSON).sort();
  assert.deepEqual(actual, expected);
  assert.ok(actual.length > 0);

  // optimal = lexicographic minimum, consistent with the reference
  const optimal = selectOptimalAssignment(enumerateFeasibleAssignments(orders, budgets));
  assert.equal(canonicalJSON(optimal), expected[0]);

  // replaying the optimal assignment through real transactions commits cleanly
  const s = new Scheduler();
  for (const b of budgets) s.setBudget(b.material, b.day, b.limit);
  for (const o of orders) s.addOrder(o.id, o.plans);
  for (const pick of optimal) {
    const { certificate } = s.scheduleOrder(pick.orderId);
    assert.deepEqual(certificate.chosen.plan, pick.plan);
  }
});

test('enumeration with an infeasible-everything order yields no assignments', () => {
  const budgets = [{ material: 'steel', day: 1, limit: 5 }];
  const orders = [
    { id: 'W1', plans: [[{ machine: 'M1', day: 1, material: 'steel', amount: 3 }]] },
    { id: 'W2', plans: [[{ machine: 'M1', day: 1, material: 'steel', amount: 9 }]] },
  ];
  assert.deepEqual(enumerateFeasibleAssignments(orders, budgets), []);
  assert.equal(selectOptimalAssignment([]), null);
});

test('canonical JSON: key order-insensitive hashing and plan set semantics', () => {
  const p1 = [{ amount: 1, day: 1, machine: 'M1', material: 'steel' }];
  const p2 = [{ material: 'steel', machine: 'M1', day: 1, amount: 1 }];
  assert.equal(sha256(normalizePlan(p1)), sha256(normalizePlan(p2)));
  assert.equal(canonicalJSON({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.ok(compareCanonical([{ a: 1 }], [{ a: 2 }]) < 0);
});
