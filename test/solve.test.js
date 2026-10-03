'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeProblem } = require('../src/model');
const { solve, bruteForce, horizonOf } = require('../src/solve');

function P(json) {
  return normalizeProblem(json);
}

function startVector(problem, starts) {
  return [...problem.tasks.keys()].sort().map((id) => starts.get(id));
}

test('null release means 0, null due means no deadline', () => {
  const problem = P({
    tasks: [{ id: 'a', line: 'L1', duration: 2, release: null, due: null }],
  });
  const task = problem.tasks.get('a');
  assert.equal(task.release, 0);
  assert.equal(task.due, null);
  const result = solve(problem);
  assert.equal(result.feasible, true);
  assert.equal(result.starts.get('a'), 0);
  assert.equal(result.lmax, -Infinity);
});

test('scenario 1: tight capacity, multiple optima, lexicographic tie-break', () => {
  const problem = P({
    tasks: [
      { id: 'a', line: 'L1', duration: 2, release: null, due: 4 },
      { id: 'b', line: 'L1', duration: 2, release: null, due: 4 },
      { id: 'c', line: 'L2', duration: 1, release: null, due: 1 },
    ],
    capacity: { L1: { '*': 1 } },
  });
  // Feasible optima: (a@0,b@2) and (a@2,b@0), both with maxLateness 0.
  const result = solve(problem);
  assert.equal(result.feasible, true);
  assert.equal(result.lmax, 0);
  assert.deepEqual(startVector(problem, result.starts), [0, 2, 0]);
  const reference = bruteForce(problem);
  assert.equal(reference.feasible, true);
  assert.equal(reference.lmax, 0);
  assert.deepEqual(startVector(problem, reference.starts), [0, 2, 0]);
});

test('precedence is enforced', () => {
  const problem = P({
    tasks: [
      { id: 'a', line: 'L1', duration: 2, release: null, due: null },
      { id: 'b', line: 'L2', duration: 1, release: null, due: null },
    ],
    precedence: [['a', 'b']],
  });
  const result = solve(problem);
  assert.equal(result.feasible, true);
  assert.ok(result.starts.get('a') + 2 <= result.starts.get('b'));
});

test('per-slot capacity override is enforced', () => {
  const problem = P({
    tasks: [
      { id: 'a', line: 'L1', duration: 1, release: null, due: null },
      { id: 'b', line: 'L1', duration: 1, release: null, due: null },
    ],
    capacity: { L1: { '0': 2 } },
  });
  const result = solve(problem);
  assert.equal(result.feasible, true);
  assert.deepEqual(startVector(problem, result.starts), [0, 0]);
});

test('due conflict is proven infeasible (exhaustive, no timeout)', () => {
  const problem = P({
    tasks: [
      { id: 'a', line: 'L1', duration: 2, release: 0, due: 2 },
      { id: 'b', line: 'L1', duration: 2, release: 0, due: 2 },
    ],
  });
  assert.equal(solve(problem).feasible, false);
  assert.equal(bruteForce(problem).feasible, false);
});

test('precedence cycle is infeasible', () => {
  const problem = P({
    tasks: [
      { id: 'a', line: 'L1', duration: 1, release: null, due: null },
      { id: 'b', line: 'L1', duration: 1, release: null, due: null },
    ],
    precedence: [['a', 'b'], ['b', 'a']],
  });
  assert.equal(solve(problem).feasible, false);
});

test('horizon bound covers worst case', () => {
  const problem = P({
    tasks: [
      { id: 'a', line: 'L1', duration: 3, release: 5, due: null },
      { id: 'b', line: 'L1', duration: 2, release: null, due: null },
    ],
  });
  assert.equal(horizonOf(problem), 10);
  const result = solve(problem);
  assert.equal(result.starts.get('a'), 5);
});

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

test('cross-validation: solve matches bruteForce on random instances (<= 8 tasks)', () => {
  const rand = lcg(20261004);
  const pick = (n) => Math.floor(rand() * n);
  for (let instance = 0; instance < 200; instance += 1) {
    const taskCount = 1 + pick(5);
    const lines = ['L1', 'L2'];
    const tasks = [];
    for (let i = 0; i < taskCount; i += 1) {
      const duration = 1 + pick(2);
      const release = rand() < 0.5 ? null : pick(2);
      const base = (release ?? 0) + duration;
      const due = rand() < 0.5 ? null : base + pick(4);
      tasks.push({
        id: 't' + i,
        line: lines[pick(2)],
        duration,
        release,
        due,
      });
    }
    const precedence = [];
    for (let i = 0; i < taskCount; i += 1) {
      for (let j = i + 1; j < taskCount; j += 1) {
        if (rand() < 0.2) precedence.push(['t' + i, 't' + j]);
      }
    }
    const capacity = {};
    if (rand() < 0.4) {
      const line = lines[pick(2)];
      capacity[line] = { [String(pick(3))]: pick(2) };
    }
    const problem = P({ tasks, precedence, capacity });
    const expected = bruteForce(problem);
    const actual = solve(problem);
    assert.equal(
      actual.feasible,
      expected.feasible,
      `feasibility mismatch on instance ${instance}: ${JSON.stringify({ tasks, precedence, capacity })}`,
    );
    if (expected.feasible) {
      assert.equal(actual.lmax, expected.lmax, `lmax mismatch on instance ${instance}`);
      assert.deepEqual(
        startVector(problem, actual.starts),
        startVector(problem, expected.starts),
        `start vector mismatch on instance ${instance}`,
      );
    }
  }
});
