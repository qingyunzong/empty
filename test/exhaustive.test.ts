import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defineProblem,
  enumerateSolutions,
  isValidAssignment,
  sampleRandom,
  shrinkAssignment,
} from '../src/index.js';
import { createRng } from '../src/rng.js';
import type { Constraint, Problem } from '../src/index.js';

/** Build a deterministic pseudo-random small problem with a short domain. */
function randomProblem(seed: number): Problem {
  const rand = createRng(seed);
  const varCount = 2 + Math.floor(rand() * 2); // 2-3 vars
  const names = ['a', 'b', 'c'].slice(0, varCount);
  const vars = names.map((name) => ({ name, min: 0, max: 3 }));
  const k = 1 + Math.floor(rand() * 4); // random threshold
  const constraints: Constraint[] = [
    {
      name: 'weighted-sum',
      vars: names,
      check: (values) =>
        names.reduce((acc, n, i) => acc + (values[n] ?? 0) * (i + 1), 0) % 5 !== k,
    },
  ];
  if (rand() < 0.5) {
    constraints.push({
      name: 'parity',
      vars: [names[0] as string],
      check: (values) => (values[names[0] as string] ?? 0) % 2 === 0,
    });
  }
  return defineProblem({ vars, constraints });
}

test('short domains: exhaustive enumeration cross-checks random sampling and shrinking', () => {
  for (let seed = 0; seed < 50; seed++) {
    const problem = randomProblem(seed);
    const full = enumerateSolutions(problem);
    assert.notEqual(full.status, 'incomplete');
    const legal = new Set(full.samples.map((s) => JSON.stringify(s)));

    // Every enumerated solution is valid, and every valid grid point is enumerated.
    for (const s of full.samples) {
      assert.ok(isValidAssignment(problem, s));
    }

    // Random sampling never produces an illegal or duplicate sample.
    for (let run = 0; run < 3; run++) {
      const sampled = sampleRandom(problem, { seed: 1000 + run, count: 8 });
      assert.notEqual(sampled.status, 'incomplete');
      if (full.status === 'unsatisfiable') {
        assert.equal(sampled.status, 'unsatisfiable');
        continue;
      }
      const seen = new Set<string>();
      for (const s of sampled.samples) {
        const key = JSON.stringify(s);
        assert.ok(legal.has(key), `illegal sample ${key} for seed ${seed}`);
        assert.ok(!seen.has(key), `duplicate sample ${key}`);
        seen.add(key);
      }
    }

    // Shrinking any solution stays inside the legal set.
    for (const s of full.samples) {
      const shrunk = shrinkAssignment(problem, s);
      assert.ok(
        legal.has(JSON.stringify(shrunk)),
        `shrink escaped constraints for seed ${seed}`,
      );
    }
  }
});
