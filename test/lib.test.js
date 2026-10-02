'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../src/lib');

// ---------- Acceptance scenario 1: tie broken lexicographically ----------

test('scenario 1: two fully qualified machines tied -> lexicographic award', () => {
  const data = {
    order: [{ order: 'O1', process: 'P1' }],
    machines: [
      { machine: 'M1', process: 'P1', cert_expiry: '2027-01-01' },
      { machine: 'M2', process: 'P1', cert_expiry: '2027-01-01' },
    ],
    costs: [
      { machine: 'M1', shift_cost: 10 },
      { machine: 'M2', shift_cost: 10 },
    ],
    budget: 100,
  };
  const result = lib.award(data);
  assert.equal(result.status, 'awarded');
  assert.deepEqual(result.machines, ['M1']);
  assert.equal(result.cost, 10);

  // Same tie, ids chosen so numeric and lexicographic orders disagree.
  const data2 = {
    ...data,
    machines: [
      { machine: 'M2', process: 'P1', cert_expiry: '2027-01-01' },
      { machine: 'M10', process: 'P1', cert_expiry: '2027-01-01' },
    ],
    costs: [
      { machine: 'M2', shift_cost: 7 },
      { machine: 'M10', shift_cost: 7 },
    ],
  };
  const result2 = lib.award(data2);
  assert.deepEqual(result2.machines, ['M10'], 'lexicographic: M10 < M2');
});

// ---------- Acceptance scenario 2: null cert excludes every combo ----------

test('scenario 2: null cert_expiry never qualifies, combos needing it excluded', () => {
  const data = {
    order: [{ order: 'O1', process: 'P1' }, { order: 'O1', process: 'P2' }],
    machines: [
      { machine: 'M1', process: 'P1', cert_expiry: '2027-01-01' },
      { machine: 'M1', process: 'P2', cert_expiry: null },
      { machine: 'M2', process: 'P1', cert_expiry: null },
      { machine: 'M2', process: 'P2', cert_expiry: '2027-01-01' },
      { machine: 'M3', process: 'P1', cert_expiry: '2027-01-01' },
      { machine: 'M3', process: 'P2', cert_expiry: null },
    ],
    costs: [
      { machine: 'M1', shift_cost: 5 },
      { machine: 'M2', shift_cost: 5 },
      { machine: 'M3', shift_cost: 1 },
    ],
    budget: 100,
  };
  const { feasible, perProcess } = lib.candidates(data);
  // Only M2 holds a valid P2 cert, so every feasible combo must contain M2.
  assert.ok(feasible.length > 0);
  for (const combo of feasible) {
    assert.ok(combo.machines.includes('M2'), `combo ${combo.machines} lacks the only P2-certified machine`);
  }
  // M3 is cheap but its P2 cert is null: {M3} and {M1,M3} must not appear.
  assert.ok(!feasible.some((c) => c.machines.join(',') === 'M3'));
  assert.ok(!feasible.some((c) => c.machines.join(',') === 'M1,M3'));
  const p2 = perProcess.find((r) => r.process === 'P2');
  assert.deepEqual(p2.machines, ['M2']);

  const result = lib.award(data);
  assert.equal(result.status, 'awarded');
  assert.deepEqual(result.machines, ['M2', 'M3']);

  // A process whose only cert is null -> infeasible with missing_capability certificate.
  const stuck = lib.award({
    order: [{ order: 'O2', process: 'P3' }],
    machines: [{ machine: 'M9', process: 'P3', cert_expiry: null }],
    costs: [{ machine: 'M9', shift_cost: 1 }],
    budget: 100,
  });
  assert.equal(stuck.status, 'infeasible');
  assert.equal(stuck.reason, 'missing_capability');
  assert.equal(stuck.process, 'P3');
});

// ---------- Acceptance scenario 3: budget cut retracts and re-awards ----------

test('scenario 3: budget decrease invalidates plan, switches to alternative', () => {
  const data = {
    order: [{ order: 'O1', process: 'P1' }, { order: 'O1', process: 'P2' }],
    machines: [
      { machine: 'M1', process: 'P1', cert_expiry: '2027-01-01' },
      { machine: 'M1', process: 'P2', cert_expiry: '2027-01-01' },
      { machine: 'M2', process: 'P1', cert_expiry: '2027-01-01' },
      { machine: 'M3', process: 'P2', cert_expiry: '2027-01-01' },
    ],
    costs: [
      { machine: 'M1', shift_cost: 18 },
      { machine: 'M2', shift_cost: 6 },
      { machine: 'M3', shift_cost: 6 },
    ],
    budget: 20,
  };
  // Fewest machines wins first: single-machine {M1} at cost 18 <= 20.
  const first = lib.award(data);
  assert.equal(first.status, 'awarded');
  assert.deepEqual(first.machines, ['M1']);

  // Budget cut to 15: {M1} (18) no longer fits; switch to backup {M2,M3} (12).
  const { state, transition } = lib.applyChange(
    { data, award: first },
    { type: 'set_budget', budget: 15 },
  );
  assert.equal(transition.retracted.status, 'awarded');
  assert.deepEqual(transition.retracted.machines, ['M1']);
  assert.deepEqual(transition.diff, { removed: ['M1'], added: ['M2', 'M3'] });
  assert.equal(transition.award.status, 'awarded');
  assert.deepEqual(transition.award.machines, ['M2', 'M3']);
  assert.equal(transition.award.cost, 12);

  // Budget cut below the cheapest cover (12) -> infeasible with budget certificate.
  const final = lib.applyChange(state, { type: 'set_budget', budget: 11 });
  assert.equal(final.transition.award.status, 'infeasible');
  assert.equal(final.transition.award.reason, 'budget');
  assert.equal(final.transition.award.min_cost, 12);
  assert.equal(final.transition.award.budget, 11);
  assert.deepEqual(final.transition.diff, { removed: ['M2', 'M3'], added: [] });
});

test('cert revocation retracts award and re-allocates', () => {
  const data = {
    order: [{ order: 'O1', process: 'P1' }],
    machines: [
      { machine: 'M1', process: 'P1', cert_expiry: '2027-01-01' },
      { machine: 'M2', process: 'P1', cert_expiry: '2027-06-01' },
    ],
    costs: [
      { machine: 'M1', shift_cost: 5 },
      { machine: 'M2', shift_cost: 9 },
    ],
    budget: 20,
  };
  const first = lib.award(data);
  assert.deepEqual(first.machines, ['M1']);
  const { transition } = lib.applyChange(
    { data, award: first },
    { type: 'revoke_cert', machine: 'M1', process: 'P1' },
  );
  assert.deepEqual(transition.diff, { removed: ['M1'], added: ['M2'] });
  assert.deepEqual(transition.award.machines, ['M2']);
  assert.equal(transition.award.cost, 9);
});

// ---------- Reference check: independent full-subset enumeration (n <= 12) ----------

// Deliberately independent re-implementation of the spec for cross-checking.
function referenceBest(data) {
  const procs = [...new Set(data.order.map((r) => r.process))];
  const valid = new Set(
    data.machines.filter((r) => r.cert_expiry !== null).map((r) => `${r.machine}${r.process}`),
  );
  const costOf = new Map(data.costs.map((r) => [r.machine, r.shift_cost]));
  const all = [...new Set(data.machines.map((r) => r.machine))];
  const budget = data.budget === undefined ? Infinity : data.budget;
  let best = null;
  for (let mask = 1; mask < 2 ** all.length; mask += 1) {
    const combo = all.filter((_, i) => mask & (1 << i)).sort();
    const ok = procs.every((p) => combo.some((m) => valid.has(`${m}${p}`)));
    if (!ok) continue;
    const cost = combo.reduce((s, m) => s + costOf.get(m), 0);
    if (cost > budget) continue;
    const key = [combo.length, cost, combo.join('')];
    if (!best
      || key[0] < best.key[0]
      || (key[0] === best.key[0] && key[1] < best.key[1])
      || (key[0] === best.key[0] && key[1] === best.key[1] && key[2] < best.key[2])) {
      best = { combo, cost, key };
    }
  }
  return best;
}

function randomData(rng, nMachines) {
  const procs = ['P1', 'P2', 'P3'];
  const machines = [];
  const costs = [];
  for (let i = 0; i < nMachines; i += 1) {
    const id = `M${i}`;
    for (const p of procs) {
      if (rng() < 0.6) {
        machines.push({
          machine: id,
          process: p,
          cert_expiry: rng() < 0.25 ? null : '2027-01-01',
        });
      }
    }
    costs.push({ machine: id, shift_cost: 1 + Math.floor(rng() * 20) });
  }
  const order = procs.filter(() => rng() < 0.8).map((p) => ({ order: 'O1', process: p }));
  if (order.length === 0) order.push({ order: 'O1', process: 'P1' });
  const budget = rng() < 0.5 ? 10 + Math.floor(rng() * 40) : undefined;
  return { order, machines, costs, budget };
}

test('reference: award matches independent full-subset enumeration (<=12 machines)', () => {
  let seed = 123456789;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  for (let trial = 0; trial < 200; trial += 1) {
    const n = 1 + Math.floor(rng() * 12);
    const data = randomData(rng, n);
    const expected = referenceBest(data);
    const actual = lib.award(data);
    if (!expected) {
      assert.equal(actual.status, 'infeasible', `trial ${trial}: expected infeasible`);
    } else {
      assert.equal(actual.status, 'awarded', `trial ${trial}: expected award`);
      assert.deepEqual(actual.machines, expected.combo, `trial ${trial} machines`);
      assert.equal(actual.cost, expected.cost, `trial ${trial} cost`);
    }
  }
});

test('reference: infeasible certificates are well-formed', () => {
  const missing = lib.infeasibleCertificate({
    order: [{ order: 'O', process: 'PX' }],
    machines: [{ machine: 'M1', process: 'PX', cert_expiry: null }],
    costs: [{ machine: 'M1', shift_cost: 1 }],
    budget: 5,
  });
  assert.equal(missing.reason, 'missing_capability');
  assert.equal(missing.process, 'PX');

  const budget = lib.infeasibleCertificate({
    order: [{ order: 'O', process: 'PX' }],
    machines: [{ machine: 'M1', process: 'PX', cert_expiry: '2027-01-01' }],
    costs: [{ machine: 'M1', shift_cost: 10 }],
    budget: 5,
  });
  assert.equal(budget.reason, 'budget');
  assert.equal(budget.min_cost, 10);
  assert.deepEqual(budget.cheapest_combination, ['M1']);
});
