import test from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline } from '../src/pipeline.js';
import { bruteForce, R } from '../support/reference.js';
import { rcmp, rat } from '../src/rational.js';

// Scenario shared by the DSL under test and the reference oracle.
// fractions are per-gram quality attributes (ppm on the DSL side).
const SCENARIO = {
  totalG: 200,
  stepG: 20,
  minProtein: R(150000, 1000000),
  maxFat: R(90000, 1000000),
  ingredients: [
    { name: 'barley', costPerG: R(28, 10000), stockG: 120, allergenPerG: R(2), protein: R(100000, 1000000), fat: R(30000, 1000000) },
    { name: 'corn', costPerG: R(32, 10000), stockG: 200, allergenPerG: R(1), protein: R(90000, 1000000), fat: R(40000, 1000000) },
    { name: 'soy', costPerG: R(48, 10000), stockG: 90, allergenPerG: R(3), protein: R(400000, 1000000), fat: R(20000, 1000000) },
    { name: 'whey', costPerG: R(80, 10000), stockG: 60, allergenPerG: R(5), protein: R(700000, 1000000), fat: R(10000, 1000000) },
  ],
};

function scenarioDsl(s) {
  const blocks = s.ingredients.map((i) => `ingredient ${i.name} {
  cost ${Number(i.costPerG[0]) / Number(i.costPerG[1]) * 1000} CNY/kg;
  stock ${i.stockG} g;
  allergen ${i.allergenPerG[0]};
  protein ${Number(i.protein[0]) * 1000000 / Number(i.protein[1])} ppm;
  fat ${Number(i.fat[0]) * 1000000 / Number(i.fat[1])} ppm;
}`).join('\n');
  const names = s.ingredients.map((i) => i.name);
  const sum = (attr) => names.map((n) => `${n}.${attr} * ${n}.grams`).join(' + ');
  const totalExpr = names.map((n) => `${n}.grams`).join(' + ');
  return `${blocks}
total ${s.totalG} g;
step ${s.stepG} g;
constraint ${sum('protein')} >= ${Number(s.minProtein[0]) * 1000000 / Number(s.minProtein[1])} ppm * (${totalExpr});
constraint ${sum('fat')} <= ${Number(s.maxFat[0]) * 1000000 / Number(s.maxFat[1])} ppm * (${totalExpr});
minimize ${names.map((n) => `${n}.grams * ${n}.cost`).join(' + ')};
`;
}

function scenarioReference(s) {
  const names = s.ingredients.map((i) => i.name);
  const idx = Object.fromEntries(names.map((n, i) => [n, i]));
  const weighted = (attr) => (grams) =>
    s.ingredients.reduce((acc, ing, i) => {
      const term = R(ing[attr][0] * BigInt(grams[i]), ing[attr][1]);
      return [acc[0] * term[1] + term[0] * acc[1], acc[1] * term[1]];
    }, R(0));
  const totalR = R(s.totalG);
  return {
    ingredients: s.ingredients.map((i) => ({ name: i.name, costPerG: i.costPerG, stockG: i.stockG, allergenPerG: i.allergenPerG })),
    totalG: s.totalG,
    stepG: s.stepG,
    constraints: [
      { lhs: weighted('protein'), op: '>=', rhs: () => R(s.minProtein[0] * totalR[0], s.minProtein[1]) },
      { lhs: weighted('fat'), op: '<=', rhs: () => R(s.maxFat[0] * totalR[0], s.maxFat[1]) },
    ],
    objective: (grams) =>
      s.ingredients.reduce((acc, ing, i) => {
        const term = R(ing.costPerG[0] * BigInt(grams[i]), ing.costPerG[1]);
        return [acc[0] * term[1] + term[0] * acc[1], acc[1] * term[1]];
      }, R(0)),
  };
}

test('acceptance 1: solver matches the brute-force reference (4 ingredients)', () => {
  const { result } = runPipeline(scenarioDsl(SCENARIO), 'scenario.dsl');
  assert.equal(result.status, 'OPTIMAL');
  const ref = bruteForce(scenarioReference(SCENARIO));
  assert.ok(ref, 'reference found a feasible plan');
  assert.equal(rcmp(result.plan.cost, rat(ref.cost[0], ref.cost[1])), 0, 'same optimal cost');
  for (let i = 0; i < SCENARIO.ingredients.length; i++) {
    const name = SCENARIO.ingredients[i].name;
    assert.equal(result.plan.grams[name], ref.grams[i], `grams of ${name}`);
  }
});

test('acceptance 1b: solver matches reference with 8 ingredients', () => {
  const eight = {
    ...SCENARIO,
    totalG: 160,
    stepG: 20,
    minProtein: R(120000, 1000000),
    ingredients: [
      ...SCENARIO.ingredients,
      { name: 'oats', costPerG: R(25, 10000), stockG: 100, allergenPerG: R(1), protein: R(110000, 1000000), fat: R(70000, 1000000) },
      { name: 'peas', costPerG: R(40, 10000), stockG: 100, allergenPerG: R(2), protein: R(220000, 1000000), fat: R(15000, 1000000) },
      { name: 'rice', costPerG: R(30, 10000), stockG: 100, allergenPerG: R(0), protein: R(80000, 1000000), fat: R(8000, 1000000) },
      { name: 'bran', costPerG: R(18, 10000), stockG: 100, allergenPerG: R(4), protein: R(140000, 1000000), fat: R(45000, 1000000) },
    ],
  };
  const { result } = runPipeline(scenarioDsl(eight), 'eight.dsl');
  assert.equal(result.status, 'OPTIMAL');
  const ref = bruteForce(scenarioReference(eight));
  assert.ok(ref);
  assert.equal(rcmp(result.plan.cost, rat(ref.cost[0], ref.cost[1])), 0);
  for (let i = 0; i < eight.ingredients.length; i++) {
    assert.equal(result.plan.grams[eight.ingredients[i].name], ref.grams[i]);
  }
});

test('acceptance 2: equal-cost ties break on lower total allergen', () => {
  const src = `
ingredient alpha { cost 1 CNY/kg; stock 1 kg; allergen 2; }
ingredient beta { cost 1 CNY/kg; stock 1 kg; allergen 1; }
total 100 g;
step 50 g;
minimize alpha.grams * alpha.cost + beta.grams * beta.cost;
`;
  const { result } = runPipeline(src, 'tie.dsl');
  assert.equal(result.status, 'OPTIMAL');
  assert.deepEqual(result.plan.grams, { alpha: 0, beta: 100 }, 'allergen-free plan wins');
  assert.equal(result.plan.allergen.n, 100n);
});

test('acceptance 2b: equal cost and allergen break on ingredient name order', () => {
  const src = `
ingredient alpha { cost 1 CNY/kg; stock 1 kg; allergen 1; }
ingredient beta { cost 1 CNY/kg; stock 1 kg; allergen 1; }
total 100 g;
step 50 g;
minimize alpha.grams * alpha.cost + beta.grams * beta.cost;
`;
  const { result } = runPipeline(src, 'tie2.dsl');
  assert.equal(result.status, 'OPTIMAL');
  // support ["alpha"] is lexicographically smaller than ["alpha","beta"] and ["beta"]
  assert.deepEqual(result.plan.grams, { alpha: 100, beta: 0 });
});

test('acceptance 2c: equal support breaks on the name-sorted gram vector', () => {
  const src = `
ingredient alpha { cost 1 CNY/kg; stock 1 kg; allergen 0; }
ingredient beta { cost 1 CNY/kg; stock 1 kg; allergen 0; }
total 100 g;
step 20 g;
constraint alpha.grams >= 20 g;
constraint beta.grams >= 20 g;
minimize alpha.grams * alpha.cost + beta.grams * beta.cost;
`;
  const { result } = runPipeline(src, 'tie3.dsl');
  assert.equal(result.status, 'OPTIMAL');
  assert.deepEqual(result.plan.grams, { alpha: 20, beta: 80 });
});

test('acceptance 3: budget exactly equal to minimum cost is OPTIMAL', () => {
  const src = `
ingredient a { cost 2 CNY/kg; stock 1 kg; }
total 100 g;
budget 0.2 CNY;
minimize a.grams * a.cost;
`;
  const { result } = runPipeline(src, 'eq.dsl');
  assert.equal(result.status, 'OPTIMAL');
  assert.equal(rcmp(result.plan.cost, rat(1n, 5n)), 0);
});

test('acceptance 3b: budget one cent below minimum cost is OVER_BUDGET', () => {
  const src = `
ingredient a { cost 2 CNY/kg; stock 1 kg; }
total 100 g;
budget 0.19 CNY;
minimize a.grams * a.cost;
`;
  const { result } = runPipeline(src, 'below.dsl');
  assert.equal(result.status, 'OVER_BUDGET');
  assert.equal(rcmp(result.plan.cost, rat(1n, 5n)), 0, 'min cost is still reported');
});

test('acceptance 4: insufficient stock is INFEASIBLE, not OVER_BUDGET', () => {
  const src = `
ingredient a { cost 2 CNY/kg; stock 500 g; }
ingredient b { cost 3 CNY/kg; stock 400 g; }
total 1 kg;
budget 100 CNY;
minimize a.grams * a.cost + b.grams * b.cost;
`;
  const { result } = runPipeline(src, 'stock.dsl');
  assert.equal(result.status, 'INFEASIBLE');
});

test('content constraint can also make a problem INFEASIBLE', () => {
  const src = `
ingredient a { cost 2 CNY/kg; stock 1 kg; protein 100000 ppm; }
total 1 kg;
constraint a.protein * a.grams >= 200000 ppm * a.grams;
minimize a.grams * a.cost;
`;
  const { result } = runPipeline(src, 'impossible.dsl');
  assert.equal(result.status, 'INFEASIBLE');
});
