import assert from 'node:assert/strict';
import test from 'node:test';
import { validateLayout, type Problem } from '../src/model.js';
import { solve } from '../src/solver.js';

test('separates two overlapping rects with minimal total movement', () => {
  // A at (0,0) 2x2, B at (1,0) 2x2 overlap; cheapest fix moves B to (2,0): total 1.
  const problem: Problem = {
    grid: 6,
    rects: [
      { id: 'A', minW: 2, maxW: 2, minH: 2, maxH: 2 },
      { id: 'B', minW: 2, maxW: 2, minH: 2, maxH: 2 },
    ],
    alignments: [],
    oldLayout: {
      A: { x: 0, y: 0, w: 2, h: 2 },
      B: { x: 1, y: 0, w: 2, h: 2 },
    },
  };
  const r = solve(problem);
  assert.equal(r.status, 'optimal');
  assert.equal(r.objective, 1);
  assert.equal(r.lowerBound, 1);
  assert.deepEqual(validateLayout(problem, r.layout!), []);
});

test('fixed alignment pins an edge to a grid line', () => {
  const problem: Problem = {
    grid: 8,
    rects: [{ id: 'A', minW: 2, maxW: 2, minH: 2, maxH: 2 }],
    alignments: [{ kind: 'fixed', a: 'A', edgeA: 'left', value: 3 }],
    oldLayout: { A: { x: 0, y: 0, w: 2, h: 2 } },
  };
  const r = solve(problem);
  assert.equal(r.status, 'optimal');
  assert.equal(r.objective, 3); // x: 0 -> 3
  assert.equal(r.layout!.A!.x, 3);
});

test('pair alignment A.right = B.left is satisfied at minimum cost', () => {
  // min |a| + |b - 4| subject to b = a + 2 -> optimum 2 (any a in [0,2]).
  const problem: Problem = {
    grid: 8,
    rects: [
      { id: 'A', minW: 2, maxW: 2, minH: 2, maxH: 2 },
      { id: 'B', minW: 2, maxW: 2, minH: 2, maxH: 2 },
    ],
    alignments: [{ kind: 'pair', a: 'A', edgeA: 'right', b: 'B', edgeB: 'left' }],
    oldLayout: {
      A: { x: 0, y: 0, w: 2, h: 2 },
      B: { x: 4, y: 0, w: 2, h: 2 },
    },
  };
  const r = solve(problem);
  assert.equal(r.status, 'optimal');
  assert.equal(r.objective, 2);
  assert.equal(r.layout!.A!.x + r.layout!.A!.w, r.layout!.B!.x);
});

test('infeasible problem is reported', () => {
  const problem: Problem = {
    grid: 4,
    rects: [
      { id: 'A', minW: 4, maxW: 4, minH: 4, maxH: 4 },
      { id: 'B', minW: 4, maxW: 4, minH: 4, maxH: 4 },
    ],
    alignments: [],
    oldLayout: {
      A: { x: 0, y: 0, w: 4, h: 4 },
      B: { x: 0, y: 0, w: 4, h: 4 },
    },
  };
  const r = solve(problem);
  assert.equal(r.status, 'infeasible');
  assert.equal(r.layout, null);
});

test('old layout already feasible => zero movement', () => {
  const problem: Problem = {
    grid: 10,
    rects: [
      { id: 'A', minW: 2, maxW: 2, minH: 2, maxH: 2 },
      { id: 'B', minW: 2, maxW: 2, minH: 2, maxH: 2 },
    ],
    alignments: [],
    oldLayout: {
      A: { x: 0, y: 0, w: 2, h: 2 },
      B: { x: 5, y: 5, w: 2, h: 2 },
    },
  };
  const r = solve(problem);
  assert.equal(r.status, 'optimal');
  assert.equal(r.objective, 0);
});

test('node budget keeps certified lower and upper bounds', () => {
  const problem: Problem = {
    grid: 20,
    rects: Array.from({ length: 8 }, (_, i) => ({
      id: `R${i}`,
      minW: 2,
      maxW: 5,
      minH: 2,
      maxH: 4,
    })),
    alignments: [],
    oldLayout: Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [
        `R${i}`,
        { x: 6 + (i % 3), y: 6 + Math.floor(i / 3), w: 3, h: 3 },
      ]),
    ),
  };
  const r = solve(problem, { maxNodes: 50 });
  assert.equal(r.status, 'budget_exhausted');
  assert.ok(r.nodesExpanded <= 50);
  assert.ok(r.lowerBound !== null && r.lowerBound >= 0);
  if (r.objective !== null) {
    assert.ok(r.lowerBound! <= r.objective);
    assert.deepEqual(validateLayout(problem, r.layout!), []);
  }
});
