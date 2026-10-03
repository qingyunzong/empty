import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildState } from '../src/model.js';
import { solve, enumerateAll, findMinInfeasibleSubset, capacityAt, horizonOf } from '../src/solver.js';

test('minimizes max lateness on a single line', () => {
  const state = buildState({
    tasks: [
      { id: 't1', line: 'L', duration: 2, due: 3 },
      { id: 't2', line: 'L', duration: 1, due: 2 },
    ],
  });
  const sol = solve(state);
  assert.equal(sol.status, 'optimal');
  assert.equal(sol.lmax, 0);
  const starts = Object.fromEntries(sol.assignments.map((a) => [a.id, a.start]));
  assert.deepEqual(starts, { t1: 1, t2: 0 });
});

test('release null means 0, due null means infinite', () => {
  const state = buildState({
    tasks: [{ id: 'a', line: 'L', duration: 3, release: null, due: null }],
  });
  const sol = solve(state);
  assert.equal(sol.assignments[0].start, 0);
  assert.ok(sol.lmax < -1e15); // effectively -infinity
});

test('respects release dates', () => {
  const state = buildState({
    tasks: [{ id: 'a', line: 'L', duration: 1, release: 5, due: 10 }],
  });
  assert.equal(solve(state).assignments[0].start, 5);
});

test('respects precedence constraints', () => {
  const state = buildState({
    tasks: [
      { id: 'a', line: 'L', duration: 2 },
      { id: 'b', line: 'L', duration: 1 },
    ],
    precedence: [['b', 'a']],
  });
  const starts = Object.fromEntries(solve(state).assignments.map((x) => [x.id, x.start]));
  assert.equal(starts.b, 0);
  assert.equal(starts.a, 1);
});

test('precedence across different lines', () => {
  const state = buildState({
    tasks: [
      { id: 'a', line: 'L1', duration: 2 },
      { id: 'b', line: 'L2', duration: 2 },
    ],
    precedence: [['a', 'b']],
  });
  const starts = Object.fromEntries(solve(state).assignments.map((x) => [x.id, x.start]));
  assert.equal(starts.a, 0);
  assert.equal(starts.b, 2);
});

test('capacity windows allow parallel execution', () => {
  const state = buildState({
    tasks: [
      { id: 'a', line: 'L', duration: 2, due: 2 },
      { id: 'b', line: 'L', duration: 2, due: 2 },
    ],
    capacity: { L: [{ start: 0, end: 2, capacity: 2 }] },
  });
  const sol = solve(state);
  assert.equal(sol.lmax, 0);
  assert.ok(sol.assignments.every((a) => a.start === 0));
});

test('zero-capacity window blocks execution', () => {
  const state = buildState({
    tasks: [{ id: 'a', line: 'L', duration: 1, due: 10 }],
    capacity: {
      L: [
        { start: 0, end: 3, capacity: 0 },
        { start: 3, end: 10, capacity: 1 },
      ],
    },
  });
  assert.equal(solve(state).assignments[0].start, 3);
});

test('overlapping windows sum capacities', () => {
  const state = buildState({ tasks: [], capacity: {} });
  state.capacity.set('L', [
    { start: 0, end: 4, capacity: 1 },
    { start: 2, end: 6, capacity: 2 },
  ]);
  assert.equal(capacityAt(state, 'L', 1), 1);
  assert.equal(capacityAt(state, 'L', 3), 3);
  assert.equal(capacityAt(state, 'L', 5), 2);
  assert.equal(capacityAt(state, 'L', 9), 0);
});

test('enumeration counts every feasible assignment', () => {
  const state = buildState({
    tasks: [
      { id: 'a', line: 'L', duration: 1 },
      { id: 'b', line: 'L', duration: 1 },
    ],
    capacity: { L: [{ start: 0, end: 2, capacity: 1 }] },
  });
  // capacity window covers t in {0,1}; feasible ordered pairs: (0,1) and (1,0)
  const result = enumerateAll(state, { mode: 'full' });
  assert.equal(result.count, 2);
  // active-schedule enumeration finds the same optimum
  const active = enumerateAll(state);
  assert.equal(active.count, 2);
  assert.deepEqual(active.best, result.best);
});

test('proves infeasibility exhaustively (no timeout heuristic)', () => {
  const state = buildState({
    tasks: [
      { id: 'a', line: 'L', duration: 1, due: 1 },
      { id: 'b', line: 'L', duration: 1, due: 1 },
    ],
    capacity: { L: [{ start: 0, end: 1, capacity: 1 }] },
  });
  const sol = solve(state);
  assert.equal(sol.status, 'infeasible');
  assert.equal(sol.certificate.method, 'exhaustive-enumeration');
  assert.ok(Array.isArray(sol.certificate.minInfeasibleSubset));
});

test('minimum infeasible subset is locally minimal', () => {
  const state = buildState({
    tasks: [
      { id: 'a', line: 'L', duration: 1, due: 1 },
      { id: 'b', line: 'L', duration: 1, due: 1 },
      { id: 'c', line: 'L', duration: 1, due: 5 },
    ],
    capacity: { L: [{ start: 0, end: 10, capacity: 1 }] },
  });
  const subset = findMinInfeasibleSubset(state);
  // a and b both need slot [0,1) on a capacity-1 line; c and the capacity
  // element are redundant, so the minimum subset is exactly {task a, task b}
  const tasks = subset.filter((e) => e.type === 'task').map((e) => e.id);
  assert.deepEqual(tasks.sort(), ['a', 'b']);
  assert.equal(subset.length, 2);
});

test('infeasible precedence cycle is rejected by the model', () => {
  assert.throws(
    () =>
      buildState({
        tasks: [
          { id: 'a', line: 'L', duration: 1 },
          { id: 'b', line: 'L', duration: 1 },
        ],
        precedence: [['a', 'b'], ['b', 'a']],
      }),
    /cycle/,
  );
});

test('horizon covers releases and window ends', () => {
  const state = buildState({
    tasks: [{ id: 'a', line: 'L', duration: 2, release: 7 }],
    capacity: { L: [{ start: 0, end: 20, capacity: 1 }] },
  });
  assert.ok(horizonOf(state) >= 20);
});
