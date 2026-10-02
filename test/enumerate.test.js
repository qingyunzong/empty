import test from 'node:test';
import assert from 'node:assert/strict';
import { solve, UNLIMITED_BUDGETS, signatureOf } from '../src/solver.js';
import { enumerateOptimum } from '../src/enumerate.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomInstance(rand) {
  const int = (n) => Math.floor(rand() * n);
  const pick = (arr) => arr[int(arr.length)];
  const subset = (arr, maxSize) => {
    const size = 1 + int(Math.min(maxSize, arr.length));
    const shuffled = [...arr].sort(() => rand() - 0.5);
    return shuffled.slice(0, size);
  };
  const config = {
    days: 1 + int(2),
    maxRunsPerDay: 1 + int(2),
    slotsPerRun: 1 + int(2),
    tempDelta: pick([0, 100, 200]),
    gasBudget: 4 + int(9),
    crucibles: { alumina: 1 + int(2), graphite: 1 + int(2) },
    rampProfiles: { standard: { maxRamp: 10 }, fast: { maxRamp: 20 } },
    hazardous: ['H2', 'CO'],
    minCoverage: int(9),
  };
  // Keep the run count small enough for exhaustive enumeration.
  while (config.days * config.maxRunsPerDay > 3) {
    if (config.days > 1) config.days -= 1;
    else config.maxRunsPerDay -= 1;
  }
  const n = 1 + int(9); // 1..9 recipes
  const recipes = [];
  for (let k = 0; k < n; k++) {
    recipes.push({
      id: `R${k}`,
      priority: 1 + int(5),
      temps: subset([600, 700, 800], 2),
      atmospheres: subset(['air', 'H2', 'CO', 'N2'], 2),
      durations: subset([1, 2], 2),
      crucible: pick(['alumina', 'graphite']),
      gasPerHour: int(3),
      rampRequired: pick([0, 5, 10, 15, 20, 25]),
    });
  }
  const locks = {};
  if (rand() < 0.3) {
    const count = 1 + int(2);
    for (let k = 0; k < count; k++) {
      const recipe = pick(recipes);
      locks[recipe.id] = {
        run: int(config.days * config.maxRunsPerDay),
        temp: pick(recipe.temps),
        atmosphere: pick(recipe.atmospheres),
        duration: pick(recipe.durations),
      };
    }
  }
  return { config, recipes, locks };
}

test('solver matches brute-force enumeration on random instances with n<=9', () => {
  const COUNT = 60;
  let optimal = 0;
  let unsat = 0;
  for (let seed = 1; seed <= COUNT; seed++) {
    const instance = randomInstance(rng(seed * 7919));
    const solved = solve(instance, UNLIMITED_BUDGETS);
    const enumerated = enumerateOptimum(instance);
    assert.equal(
      solved.status,
      enumerated.status,
      `status mismatch on seed ${seed}: ${JSON.stringify(instance)}`,
    );
    if (solved.status === 'OPTIMAL') {
      optimal += 1;
      assert.equal(solved.weight, enumerated.weight, `weight mismatch on seed ${seed}`);
      assert.deepEqual(
        signatureOf(solved.scheduled),
        signatureOf(enumerated.scheduled),
        `scheduled set mismatch on seed ${seed}`,
      );
      // Sanity: scheduled runs stay inside the horizon.
      const maxRun = instance.config.days * instance.config.maxRunsPerDay;
      for (const s of solved.scheduled) {
        assert.ok(s.run >= 0 && s.run < maxRun, `run out of range on seed ${seed}`);
      }
    } else {
      unsat += 1;
      assert.ok(Array.isArray(solved.core), `UNSAT without core on seed ${seed}`);
    }
  }
  assert.ok(optimal > 0 && unsat > 0, `want a mix of OPTIMAL(${optimal}) and UNSAT(${unsat})`);
});
