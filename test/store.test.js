import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, selectPlan, scheduleOrder, hashPlan, canonicalPlan, BudgetError } from '../src/index.js';

const steel = (machine, amount, day = 1) => [{ machine, day, material: 'steel', amount }];

// Acceptance 1: budget 100, equivalent plans A and B each use 80;
// lexicographically smaller A wins, certificate lists B's hash.
test('deterministic selection: lexicographically smallest feasible plan wins, certificate lists compared hashes', () => {
  const store = new Store();
  store.setBudget('steel', 1, 100);
  const planA = steel('m1', 80);
  const planB = steel('m2', 80);
  const order = { id: 'o1', plans: [planB, planA] }; // input order must not matter

  const result = scheduleOrder(store, order);
  assert.deepEqual(result.plan, planA);
  assert.equal(result.certificate.chosen, hashPlan(planA));
  assert.ok(result.certificate.compared.includes(hashPlan(planB)), 'certificate must contain hash of B');
  assert.deepEqual(
    [...result.certificate.compared].sort(),
    [hashPlan(planA), hashPlan(planB)].sort(),
  );
});

// Acceptance 2a: two concurrent transactions, 60 + 60 > budget 100.
// They write different work orders but share the same budget predicate:
// the second commit must fail with E_BUDGET.
test('concurrent txns on different orders cannot bypass shared budget predicate (60+60>100)', () => {
  const store = new Store();
  store.setBudget('steel', 1, 100);

  const t1 = store.begin();
  const t2 = store.begin();
  assert.equal(t1.snapshotVersion, t2.snapshotVersion);

  const s1 = selectPlan(t1, { id: 'o1', plans: [steel('m1', 60)] });
  const s2 = selectPlan(t2, { id: 'o2', plans: [steel('m2', 60)] });
  t1.stage('o1', s1.plan);
  t2.stage('o2', s2.plan);

  t1.commit();
  assert.throws(() => t2.commit(), (err) => {
    assert.ok(err instanceof BudgetError);
    assert.equal(err.code, 'E_BUDGET');
    assert.equal(err.details.committed, 60);
    assert.equal(err.details.staged, 60);
    assert.equal(err.details.budget, 100);
    return true;
  });
  assert.equal(store.committedSum('steel', 1), 60);
});

// Acceptance 2b: 50 + 50 <= 100, both concurrent transactions commit.
test('concurrent txns both commit when joint usage fits (50+50<=100)', () => {
  const store = new Store();
  store.setBudget('steel', 1, 100);

  const t1 = store.begin();
  const t2 = store.begin();
  t1.stage('o1', selectPlan(t1, { id: 'o1', plans: [steel('m1', 50)] }).plan);
  t2.stage('o2', selectPlan(t2, { id: 'o2', plans: [steel('m2', 50)] }).plan);

  t1.commit();
  t2.commit();
  assert.equal(store.committedSum('steel', 1), 100);
});

// Acceptance 3: exact budget exhaustion succeeds; then 0 more succeeds,
// 1 more fails with E_BUDGET.
test('exact exhaustion: 100 commits, then 0 commits, then 1 fails', () => {
  const store = new Store();
  store.setBudget('steel', 1, 100);

  scheduleOrder(store, { id: 'o1', plans: [steel('m1', 100)] });
  assert.equal(store.committedSum('steel', 1), 100);

  const zero = scheduleOrder(store, { id: 'o2', plans: [steel('m1', 0)] });
  assert.ok(zero.version > 0);

  assert.throws(
    () => scheduleOrder(store, { id: 'o3', plans: [steel('m1', 1)] }),
    (err) => err.code === 'E_BUDGET',
  );
});

test('snapshot isolation: txn does not see allocations committed after its snapshot', () => {
  const store = new Store();
  store.setBudget('steel', 1, 100);
  const t1 = store.begin();
  scheduleOrder(store, { id: 'o1', plans: [steel('m1', 70)] });
  assert.equal(t1.remaining('steel', 1), 100, 'stale snapshot still sees full budget');
  assert.equal(store.committedSum('steel', 1), 70);
  // Commit-time revalidation still protects the predicate.
  t1.stage('o2', steel('m1', 40));
  assert.throws(() => t1.commit(), (err) => err.code === 'E_BUDGET');
});

test('budgets are tracked per (material, day) via the secondary index', () => {
  const store = new Store();
  store.setBudget('steel', 1, 100);
  store.setBudget('steel', 2, 50);
  store.setBudget('hours', 1, 40);
  scheduleOrder(store, {
    id: 'o1',
    plans: [[
      { machine: 'm1', day: 1, material: 'steel', amount: 60 },
      { machine: 'm1', day: 1, material: 'hours', amount: 40 },
    ]],
  });
  assert.equal(store.committedSum('steel', 1), 60);
  assert.equal(store.committedSum('steel', 2), 0);
  assert.equal(store.committedSum('hours', 1), 40);
  const txn = store.begin();
  assert.equal(txn.remaining('steel', 1), 40);
  assert.equal(txn.remaining('hours', 1), 0);
  assert.equal(txn.remaining('steel', 2), 50);
});

test('invalid amounts are rejected', () => {
  const store = new Store();
  assert.throws(() => store.setBudget('steel', 1, -5), (err) => err.code === 'E_INVALID');
  store.setBudget('steel', 1, 10);
  const txn = store.begin();
  assert.throws(() => txn.stage('o1', steel('m1', 1.5)), (err) => err.code === 'E_INVALID');
});

test('canonical plan string is recorded in certificate', () => {
  const store = new Store();
  store.setBudget('steel', 1, 100);
  const plan = steel('m1', 10);
  const { certificate } = scheduleOrder(store, { id: 'o1', plans: [plan] });
  assert.equal(certificate.plan, canonicalPlan(plan));
});
