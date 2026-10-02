import test from 'node:test';
import assert from 'node:assert/strict';
import { solve } from '../src/solver.js';
import { bruteForce } from '../src/brute.js';

// Deterministic PRNG so failures reproduce exactly.
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

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const subset = (rng, arr, maxSize) => {
  const shuffled = [...arr].sort(() => rng() - 0.5);
  return shuffled.slice(0, 1 + Math.floor(rng() * Math.min(maxSize, arr.length))).sort();
};

function randomProblem(rng, n) {
  const small = n > 5; // shrink domains so enumeration stays tractable
  const tempPool = small ? [1, 2] : [1, 2, 3];
  const atmoPool = small ? ['n2', 'h2'] : ['n2', 'h2', 'o2'];
  const config = {
    days: small ? 1 : pick(rng, [1, 2]),
    maxRunsPerDay: small ? pick(rng, [1, 2]) : pick(rng, [1, 2]),
    slots: pick(rng, [1, 2, 3]),
    gasBudget: pick(rng, [2, 4, 6]),
    maxTempDiff: pick(rng, [0, 1, 3]),
    crucibles: { alumina: pick(rng, [1, 2]), graphite: pick(rng, [1, 2]) },
    gasUsage: { air: 0, n2: pick(rng, [1, 2]), h2: pick(rng, [2, 3]), o2: pick(rng, [2, 3]) },
    hazards: rng() < 0.5 ? [['h2', 'o2']] : [],
    ...(rng() < 0.5 ? { requiredPriority: pick(rng, [3, 5]) } : {}),
  };
  const recipes = [];
  for (let i = 1; i <= n; i++) {
    recipes.push({
      id: `R${i}`,
      priority: Math.floor(rng() * 6),
      temps: subset(rng, tempPool, small ? 1 : 2),
      atmos: subset(rng, atmoPool, small ? 1 : 2),
      durs: subset(rng, [1, 2], 1),
      crucible: pick(rng, ['alumina', 'graphite']),
    });
  }
  return { config, recipes, locks: [] };
}

function scheduledIds(result) {
  return Object.keys(result.assignment ?? {}).sort();
}

for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
  test(`solver matches brute-force enumeration for n=${n}`, () => {
    for (let seed = 1; seed <= 6; seed++) {
      const problem = randomProblem(mulberry32(n * 1000 + seed), n);
      const brute = bruteForce(problem);
      assert.ok(brute.nodes < 4_000_000, `enumeration exploded: ${brute.nodes} nodes (n=${n} seed=${seed})`);
      const got = solve(problem, {}, { core: false });
      if (!brute.best) {
        assert.equal(got.status, 'UNSAT', `n=${n} seed=${seed}`);
      } else {
        assert.equal(got.status, 'OPTIMAL', `n=${n} seed=${seed}`);
        assert.equal(got.objective, brute.best.weight, `objective n=${n} seed=${seed}`);
        assert.deepEqual(scheduledIds(got), brute.best.ids, `scheduled set n=${n} seed=${seed}`);
      }
    }
  });
}

test('locked instances match brute force as well', () => {
  const rng = mulberry32(42);
  for (let seed = 0; seed < 8; seed++) {
    const problem = randomProblem(rng, 4);
    const lockable = problem.recipes[0];
    problem.locks = [
      {
        recipe: lockable.id,
        batch: 0,
        temp: lockable.temps[0],
        atmo: lockable.atmos[0],
        dur: lockable.durs[0],
      },
    ];
    const brute = bruteForce(problem);
    const got = solve(problem, {}, { core: false });
    if (!brute.best) {
      assert.equal(got.status, 'UNSAT', `seed=${seed}`);
    } else {
      assert.equal(got.status, 'OPTIMAL', `seed=${seed}`);
      assert.equal(got.objective, brute.best.weight, `objective seed=${seed}`);
      assert.deepEqual(scheduledIds(got), brute.best.ids, `scheduled set seed=${seed}`);
    }
  }
});
