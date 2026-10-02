import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, repair, createBaseVersion, evaluateRule, NO_FEASIBLE, SEARCH_LIMIT, RULE_CYCLE } from '../src/index.js';
import { rng, randomInstance, bruteForceOptimum } from './helpers.js';

test('optimal plan cost matches brute-force enumeration for <=10 variables', () => {
  const rand = rng(42);
  for (let trial = 0; trial < 60; trial++) {
    const varCount = 2 + Math.floor(rand() * 9); // 2..10 variables
    const { data, schema, rules } = randomInstance(rand, { varCount, domainSize: 3, ruleCount: 5 });
    const budget = Math.floor(rand() * 12);
    const result = plan({ data, schema, rules, budget });
    const oracle = bruteForceOptimum(data, schema, rules, budget, evaluateRule);
    if (oracle === null) {
      assert.equal(result.best, null, `trial ${trial}: expected no feasible plan`);
    } else {
      assert.ok(result.best, `trial ${trial}: expected a feasible plan`);
      assert.equal(result.best.cost, oracle, `trial ${trial}: optimal cost mismatch`);
      assert.ok(result.best.cost <= budget);
      assert.equal(result.best.violations.length, 0);
    }
  }
});

test('budget 0: only the zero-cost (unchanged) plan can be feasible', () => {
  const schema = { x: { domain: [0, 1, 2] } };
  const rules = [{ id: 'r', type: 'range', var: 'x', min: 0, max: 1 }];
  // Dirty data, any fix costs >= 1 => NO_FEASIBLE at budget 0.
  assert.throws(
    () => repair({ version: createBaseVersion({ x: 2 }), schema, rules, budget: 0 }),
    (err) => err.code === NO_FEASIBLE
  );
  // Clean data: the empty plan costs 0 and is feasible at budget 0.
  const out = repair({ version: createBaseVersion({ x: 1 }), schema, rules, budget: 0 });
  assert.equal(out.plan.cost, 0);
  assert.equal(out.plan.changes.length, 0);
});

test('budget boundary: cost exactly equal to budget is feasible', () => {
  const schema = { x: { domain: [0, 5], changeCost: 3 } };
  const rules = [{ id: 'r', type: 'range', var: 'x', min: 0, max: 0 }];
  const version = createBaseVersion({ x: 5 });
  // Fix costs exactly 3: feasible at budget 3 ...
  const ok = repair({ version, schema, rules, budget: 3 });
  assert.equal(ok.plan.cost, 3);
  assert.equal(ok.version.data.x, 0);
  // ... infeasible at budget 2, proven by exhaustive enumeration.
  assert.throws(
    () => repair({ version, schema, rules, budget: 2 }),
    (err) => {
      assert.equal(err.code, NO_FEASIBLE);
      assert.equal(err.details.states, 2); // whole 2-state space was enumerated
      return true;
    }
  );
});

test('SEARCH_LIMIT is never reported as NO_FEASIBLE', () => {
  const rand = rng(7);
  const { data, schema, rules } = randomInstance(rand, { varCount: 8, domainSize: 4, ruleCount: 4 });
  // Tiny state cap: search aborts before the space is fully enumerated.
  assert.throws(
    () => plan({ data, schema, rules, budget: 0, maxStates: 5 }),
    (err) => {
      assert.equal(err.code, SEARCH_LIMIT);
      assert.notEqual(err.code, NO_FEASIBLE);
      assert.match(err.message, /not a proof of infeasibility/);
      return true;
    }
  );
});

test('NO_FEASIBLE only after exhaustive proof over the full state space', () => {
  const schema = { x: { domain: [3, 4] } };
  const rules = [{ id: 'r', type: 'range', var: 'x', min: 0, max: 1 }];
  const result = plan({ data: { x: 3 }, schema, rules, budget: 100 });
  assert.equal(result.best, null);
  assert.equal(result.exhausted, true);
  assert.equal(result.states, 2);
});

test('plans are ranked by (resolved desc, cost asc, hash asc)', () => {
  const schema = {
    a: { domain: [0, 1], changeCost: 1 },
    b: { domain: [0, 1], changeCost: 2 },
  };
  const rules = [
    { id: 'ra', type: 'range', var: 'a', min: 1, max: 1 },
    { id: 'rb', type: 'range', var: 'b', min: 1, max: 1 },
  ];
  const result = plan({ data: { a: 0, b: 0 }, schema, rules, budget: 10, maxPlans: 4 });
  assert.equal(result.plans.length, 4);
  for (let i = 1; i < result.plans.length; i++) {
    const prev = result.plans[i - 1];
    const cur = result.plans[i];
    assert.ok(prev.resolved >= cur.resolved, 'resolved desc');
    if (prev.resolved === cur.resolved) assert.ok(prev.cost <= cur.cost, 'cost asc');
    if (prev.resolved === cur.resolved && prev.cost === cur.cost) assert.ok(prev.hash < cur.hash, 'hash asc');
  }
  // The full-fix plan ranks first; the do-nothing plan ranks last.
  assert.equal(result.plans[0].resolved, 2);
  assert.equal(result.plans.at(-1).resolved, 0);
});

test('plan rejects cyclic rules with RULE_CYCLE before searching', () => {
  const rules = [
    { id: 'a', type: 'range', var: 'x', min: 0, max: 1, dependsOn: ['b'] },
    { id: 'b', type: 'range', var: 'x', min: 0, max: 1, dependsOn: ['a'] },
  ];
  assert.throws(
    () => plan({ data: { x: 0 }, schema: { x: { domain: [0, 1] } }, rules }),
    (err) => err.code === RULE_CYCLE
  );
});
