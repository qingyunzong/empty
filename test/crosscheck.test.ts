import assert from 'node:assert/strict';
import test from 'node:test';
import { bruteForce } from '../src/bruteforce.js';
import type { Problem } from '../src/model.js';
import { solve } from '../src/solver.js';

/** Deterministic PRNG (Numerical Recipes LCG). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomProblem(seed: number, grid: number, rectCount: number): Problem {
  const rand = lcg(seed);
  const rects = Array.from({ length: rectCount }, (_, i) => ({
    id: `R${i}`,
    minW: 1,
    maxW: 2,
    minH: 1,
    maxH: 2,
  }));
  const oldLayout = Object.fromEntries(
    rects.map((r) => [
      r.id,
      {
        x: Math.floor(rand() * grid),
        y: Math.floor(rand() * grid),
        w: 1 + Math.floor(rand() * 2),
        h: 1 + Math.floor(rand() * 2),
      },
    ]),
  );
  return { grid, rects, alignments: [], oldLayout };
}

test('solver matches exhaustive enumeration on random tiny-grid instances', () => {
  for (let seed = 1; seed <= 8; seed++) {
    const problem = randomProblem(seed, 4, 3);
    const solved = solve(problem, { maxNodes: 1_000_000 });
    const brute = bruteForce(problem);
    if (!brute.feasible) {
      assert.equal(solved.status, 'infeasible', `seed ${seed}`);
    } else {
      assert.equal(solved.status, 'optimal', `seed ${seed}`);
      assert.equal(solved.objective, brute.objective, `seed ${seed}`);
      assert.equal(solved.lowerBound, brute.objective, `seed ${seed}`);
    }
  }
});

test('solver matches brute force with alignment constraints', () => {
  const problem: Problem = {
    grid: 5,
    rects: [
      { id: 'a', minW: 1, maxW: 2, minH: 1, maxH: 2 },
      { id: 'b', minW: 1, maxW: 2, minH: 1, maxH: 2 },
      { id: 'c', minW: 1, maxW: 2, minH: 1, maxH: 2 },
    ],
    alignments: [
      { kind: 'pair', a: 'a', edgeA: 'right', b: 'b', edgeB: 'left' },
      { kind: 'fixed', a: 'c', edgeA: 'bottom', value: 5 },
    ],
    oldLayout: {
      a: { x: 1, y: 1, w: 2, h: 2 },
      b: { x: 2, y: 1, w: 2, h: 1 },
      c: { x: 1, y: 2, w: 1, h: 2 },
    },
  };
  const solved = solve(problem, { maxNodes: 1_000_000 });
  const brute = bruteForce(problem);
  assert.ok(brute.feasible);
  assert.equal(solved.status, 'optimal');
  assert.equal(solved.objective, brute.objective);
});

test('solver matches brute force when sizes vary over a wider range', () => {
  const problem: Problem = {
    grid: 5,
    rects: [
      { id: 'a', minW: 1, maxW: 3, minH: 1, maxH: 3 },
      { id: 'b', minW: 1, maxW: 3, minH: 1, maxH: 3 },
    ],
    alignments: [{ kind: 'pair', a: 'a', edgeA: 'bottom', b: 'b', edgeB: 'top' }],
    oldLayout: {
      a: { x: 1, y: 1, w: 2, h: 2 },
      b: { x: 1, y: 2, w: 2, h: 2 },
    },
  };
  const solved = solve(problem, { maxNodes: 1_000_000 });
  const brute = bruteForce(problem);
  assert.ok(brute.feasible);
  assert.equal(solved.status, 'optimal');
  assert.equal(solved.objective, brute.objective);
});
