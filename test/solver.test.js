import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optimalRepair, enumeratePlans } from '../src/solver.js';
import { evalRule } from '../src/rules.js';

// Deterministic PRNG so failures are reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Independent brute-force reference: full enumeration, no pruning.
function bruteForce({ data, domains, costs = {}, rules, budget = null }) {
  const vars = Object.keys(domains).sort();
  const cap = budget === null ? Infinity : budget;
  const values = [];
  let best = null;
  let bestCost = Infinity;
  function rec(i, cost) {
    if (i === vars.length) {
      const d = {};
      vars.forEach((v, j) => { d[v] = values[j]; });
      if (cost <= cap && cost < bestCost && rules.every((r) => evalRule(r, (x) => d[x]))) {
        bestCost = cost;
        best = d;
      }
      return;
    }
    const [lo, hi] = domains[vars[i]];
    for (let v = lo; v <= hi; v++) {
      values[i] = v;
      rec(i + 1, cost + Math.abs(v - data[vars[i]]) * (costs[vars[i]] ?? 1));
    }
  }
  rec(0, 0);
  return best ? { cost: bestCost } : null;
}

function randomInstance(rand, nVars) {
  const vars = Array.from({ length: nVars }, (_, i) => `v${i}`);
  const domains = {};
  const data = {};
  const costs = {};
  for (const v of vars) {
    const lo = Math.floor(rand() * 3);
    const hi = lo + 1 + Math.floor(rand() * 3); // domain size 2..4
    domains[v] = [lo, hi];
    data[v] = lo + Math.floor(rand() * (hi - lo + 1));
    costs[v] = 1 + Math.floor(rand() * 3);
  }
  const rules = [];
  const nRules = 1 + Math.floor(rand() * 4);
  for (let i = 0; i < nRules; i++) {
    const kind = Math.floor(rand() * 4);
    const pick = () => vars[Math.floor(rand() * nVars)];
    if (kind === 0) {
      const v = pick();
      const [lo, hi] = domains[v];
      const a = lo + Math.floor(rand() * (hi - lo + 1));
      const b = a + Math.floor(rand() * (hi - a + 1));
      rules.push({ id: `r${i}`, type: 'range', var: v, min: a, max: b });
    } else if (kind === 1 && nVars >= 2) {
      let a = pick(); let b = pick();
      if (a === b) b = vars[(vars.indexOf(a) + 1) % nVars];
      rules.push({ id: `r${i}`, type: 'leq', a, b });
    } else if (kind === 2 && nVars >= 2) {
      let a = pick(); let b = pick();
      if (a === b) b = vars[(vars.indexOf(a) + 1) % nVars];
      rules.push({ id: `r${i}`, type: 'eq', a, b });
    } else {
      const subset = vars.filter(() => rand() < 0.6);
      if (subset.length === 0) subset.push(vars[0]);
      const maxSum = subset.reduce((s, v) => s + domains[v][1], 0);
      rules.push({ id: `r${i}`, type: 'sumLeq', vars: subset, bound: Math.floor(rand() * (maxSum + 1)) });
    }
  }
  const budget = Math.floor(rand() * 8);
  return { data, domains, costs, rules, budget };
}

test('optimalRepair matches brute-force enumeration (<=10 variables)', () => {
  const rand = mulberry32(20261003);
  let feasibleCount = 0;
  let infeasibleCount = 0;
  for (let iter = 0; iter < 400; iter++) {
    const nVars = 1 + Math.floor(rand() * 10); // 1..10 variables
    const inst = randomInstance(rand, nVars);
    const got = optimalRepair(inst);
    const want = bruteForce(inst);
    if (want === null) {
      infeasibleCount++;
      assert.equal(got.feasible, false,
        `iter ${iter}: solver claims feasible but brute force proves NO_FEASIBLE`);
    } else {
      feasibleCount++;
      assert.equal(got.feasible, true, `iter ${iter}: solver missed a feasible solution`);
      assert.equal(got.cost, want.cost, `iter ${iter}: cost mismatch`);
      // The returned assignment must actually satisfy every rule.
      for (const r of inst.rules) {
        assert.ok(evalRule(r, (x) => got.assignment[x]), `iter ${iter}: rule ${r.id} violated`);
      }
    }
  }
  // Sanity: the random suite must exercise both sides of the boundary.
  assert.ok(feasibleCount > 50, `too few feasible cases: ${feasibleCount}`);
  assert.ok(infeasibleCount > 10, `too few infeasible cases: ${infeasibleCount}`);
});

test('optimalRepair without budget matches brute force minimum cost', () => {
  const rand = mulberry32(777);
  for (let iter = 0; iter < 150; iter++) {
    const nVars = 1 + Math.floor(rand() * 8);
    const inst = randomInstance(rand, nVars);
    inst.budget = null;
    const got = optimalRepair(inst);
    const want = bruteForce(inst);
    assert.equal(got.feasible, want !== null, `iter ${iter}`);
    if (want) assert.equal(got.cost, want.cost, `iter ${iter}`);
  }
});

test('enumeratePlans ranks by (fixed desc, cost asc, hash asc) and is deterministic', () => {
  const inst = {
    data: { x: 0, y: 5 },
    domains: { x: [0, 3], y: [0, 5] },
    costs: { x: 1, y: 2 },
    rules: [
      { id: 'r1', type: 'range', var: 'x', min: 2, max: 3 },
      { id: 'r2', type: 'leq', a: 'y', b: 'x' },
    ],
    budget: 10,
  };
  const run1 = enumeratePlans(inst);
  const run2 = enumeratePlans(inst);
  assert.deepEqual(run1, run2, 'plan enumeration must be deterministic');
  const { plans } = run1;
  assert.ok(plans.length > 1);
  for (let i = 1; i < plans.length; i++) {
    const a = plans[i - 1];
    const b = plans[i];
    const ok =
      a.fixedViolations > b.fixedViolations ||
      (a.fixedViolations === b.fixedViolations && a.cost < b.cost) ||
      (a.fixedViolations === b.fixedViolations && a.cost === b.cost && a.hash <= b.hash);
    assert.ok(ok, `ranking violated at position ${i}`);
  }
  // Top plan must fix every violation (a full repair exists within budget here).
  assert.equal(plans[0].remainingViolations.length, 0);
  assert.equal(plans[0].fixedViolations, 2);
});
