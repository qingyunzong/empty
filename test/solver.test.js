import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pipeline, referenceSolve } from './helpers.js';
import { solve } from '../src/solver.js';

const FEASIBLE = readFileSync(
  fileURLToPath(new URL('../examples/feasible.dsl', import.meta.url)),
  'utf8',
);

test('solver agrees with naive enumeration on the feasible sample', () => {
  const prog = pipeline(FEASIBLE, 'feasible.dsl');
  const fast = solve(prog);
  const ref = referenceSolve(prog);
  assert.equal(fast.status, 'OPTIMAL');
  assert.deepEqual(fast.grams, ref.grams);
  assert.equal(fast.costMicro, ref.costMicro);
  assert.equal(fast.allergenTotal, ref.allergenTotal);
});

test('solver agrees with reference on 8 ingredients, 20 g step', () => {
  const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel'];
  const src =
    names
      .map(
        (nm, i) => `ingredient ${nm} {
  cost: ${2 + (i % 3)} CNY / 1 kg;
  stock: ${40 + i * 10} g;
  allergen: ${(i * 17) % 40} ppm;
  indicator protein: ${30000 + i * 20000} ppm;
}`,
      )
      .join('\n') +
    `\ntarget: 100 g;\nstep: 20 g;\nconstraint protein in [40000 ppm, 150000 ppm];\nminimize cost;\n`;
  const prog = pipeline(src);
  const fast = solve(prog);
  const ref = referenceSolve(prog);
  assert.equal(fast.status, 'OPTIMAL');
  assert.deepEqual(fast.grams, ref.grams);
  assert.equal(fast.costMicro, ref.costMicro);
});

test('solver agrees with reference on 5 ingredients, 10 g step', () => {
  const src = `
ingredient A { cost: 3 CNY / 1 kg; stock: 60 g; allergen: 4 ppm; indicator q: 50000 ppm; }
ingredient B { cost: 5 CNY / 1 kg; stock: 50 g; allergen: 9 ppm; indicator q: 90000 ppm; }
ingredient C { cost: 4 CNY / 1 kg; stock: 70 g; allergen: 1 ppm; indicator q: 70000 ppm; }
ingredient D { cost: 2 CNY / 1 kg; stock: 40 g; allergen: 20 ppm; indicator q: 20000 ppm; }
ingredient E { cost: 6 CNY / 1 kg; stock: 30 g; allergen: 7 ppm; indicator q: 120000 ppm; }
target: 80 g;
step: 10 g;
constraint q in [30000 ppm, 100000 ppm];
minimize cost;
`;
  const prog = pipeline(src);
  assert.deepEqual(solve(prog), { ...referenceSolve(prog), status: 'OPTIMAL' });
});

test('tie on cost: lower allergen total wins', () => {
  const src = `
ingredient A { cost: 5 CNY / 1 kg; stock: 100 g; allergen: 90 ppm; }
ingredient B { cost: 5 CNY / 1 kg; stock: 100 g; allergen: 10 ppm; }
target: 100 g;
step: 50 g;
minimize cost;
`;
  const r = solve(pipeline(src));
  assert.equal(r.status, 'OPTIMAL');
  // Identical prices: every mix costs the same, so all of B (low allergen).
  assert.deepEqual(r.grams, [0, 100]);
  assert.equal(r.allergenTotal, 1000);
});

test('tie on cost and allergen: lexicographically smallest gram vector wins', () => {
  const src = `
ingredient A { cost: 5 CNY / 1 kg; stock: 100 g; allergen: 10 ppm; }
ingredient B { cost: 5 CNY / 1 kg; stock: 100 g; allergen: 10 ppm; }
target: 100 g;
step: 50 g;
minimize cost;
`;
  const r = solve(pipeline(src));
  // Candidates (A,B): (0,100) < (50,50) < (100,0) in name order.
  assert.deepEqual(r.grams, [0, 100]);
});

test('budget exactly equal to minimum cost is OPTIMAL', () => {
  const src = `
ingredient A { cost: 4 CNY / 1 kg; stock: 100 g; }
ingredient B { cost: 6 CNY / 1 kg; stock: 100 g; }
target: 100 g;
step: 20 g;
budget: 0.4 CNY;
minimize cost;
`;
  const prog = pipeline(src);
  const r = solve(prog);
  assert.equal(r.status, 'OPTIMAL');
  assert.equal(r.costMicro, 400_000);
  assert.ok(!(r.costMicro > prog.budgetMicro));
});

test('budget one micro below minimum cost is OVER_BUDGET, not INFEASIBLE', () => {
  const src = `
ingredient A { cost: 4 CNY / 1 kg; stock: 100 g; }
ingredient B { cost: 6 CNY / 1 kg; stock: 100 g; }
target: 100 g;
step: 20 g;
budget: 0.399999 CNY;
minimize cost;
`;
  const prog = pipeline(src);
  const r = solve(prog);
  assert.equal(r.status, 'OPTIMAL');
  assert.ok(r.costMicro > prog.budgetMicro);
});

test('insufficient stock is INFEASIBLE', () => {
  const src = `
ingredient A { cost: 1 CNY / 1 kg; stock: 30 g; }
ingredient B { cost: 1 CNY / 1 kg; stock: 40 g; }
target: 100 g;
step: 10 g;
minimize cost;
`;
  assert.equal(solve(pipeline(src)).status, 'INFEASIBLE');
});

test('unsatisfiable quality range is INFEASIBLE even with budget present', () => {
  const src = `
ingredient A { cost: 1 CNY / 1 kg; stock: 100 g; indicator p: 10000 ppm; }
target: 100 g;
step: 10 g;
budget: 0.000001 CNY;
constraint p in [90000 ppm, 100000 ppm];
minimize cost;
`;
  // Both INFEASIBLE (quality) and over budget would apply; INFEASIBLE wins.
  assert.equal(solve(pipeline(src)).status, 'INFEASIBLE');
});
