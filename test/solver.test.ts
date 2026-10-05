import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  MAX_VARIABLES,
  Problem,
  Solver,
  TreeNode,
  solve,
} from '../src/solver.js';
import {
  checkAssignment,
  enumerateSolutions,
  isPartialConsistent,
} from '../src/enumerator.js';

function treeLeaves(node: TreeNode): TreeNode[] {
  if (node.children.length === 0) return [node];
  return node.children.flatMap(treeLeaves);
}

function countInternal(node: TreeNode): number {
  const self = node.children.length > 0 ? 1 : 0;
  return self + node.children.reduce((sum, c) => sum + countInternal(c), 0);
}

function collectStatuses(node: TreeNode): string[] {
  return [node.status, ...node.children.flatMap(collectStatuses)];
}

const alldiff4: Problem = {
  domains: [
    [1, 2, 3, 4],
    [1, 2, 3, 4],
    [1, 2, 3, 4],
    [1, 2, 3, 4],
  ],
  constraints: [{ kind: 'allDifferent', variables: [0, 1, 2, 3] }],
};

test('allDifferent: SAT solution validated by independent enumerator', () => {
  const result = solve(alldiff4);
  assert.equal(result.status, 'SAT');
  assert.equal(result.solutions.length, 1);
  assert.ok(checkAssignment(alldiff4, result.solutions[0]));
  assert.equal(result.frontier.length, 0);
  assert.ok(result.nodes > 0);
});

test('allDifferent: findAll solution count matches brute-force enumeration', () => {
  const result = solve(alldiff4, { findAll: true });
  const brute = enumerateSolutions(alldiff4);
  assert.equal(result.status, 'SAT');
  assert.equal(brute.count, 24);
  assert.equal(result.solutions.length, brute.count);
  for (const s of result.solutions) assert.ok(checkAssignment(alldiff4, s));
});

test('allDifferent: UNSAT yields a complete, fully failed search tree', () => {
  const problem: Problem = {
    domains: [[1, 2, 3], [1, 2, 3], [1, 2, 3], [1, 2, 3]],
    constraints: [{ kind: 'allDifferent', variables: [0, 1, 2, 3] }],
  };
  const result = solve(problem);
  assert.equal(result.status, 'UNSAT');
  assert.equal(result.solutions.length, 0);
  assert.equal(enumerateSolutions(problem).count, 0);
  assert.ok(result.tree);
  const leaves = treeLeaves(result.tree!);
  assert.ok(leaves.length > 0);
  for (const leaf of leaves) assert.equal(leaf.status, 'failed');
  const statuses = collectStatuses(result.tree!);
  assert.ok(!statuses.includes('open'), 'complete tree has no open nodes');
  assert.ok(!statuses.includes('solution'));
  assert.equal(countInternal(result.tree!), result.nodes);
});

test('table constraint: SAT, counts and solutions cross-checked', () => {
  const problem: Problem = {
    domains: [[0, 1, 2], [0, 1, 2], [0, 1, 2]],
    constraints: [
      {
        kind: 'table',
        variables: [0, 1],
        tuples: [
          [0, 1],
          [1, 2],
          [2, 0],
        ],
      },
      { kind: 'allDifferent', variables: [0, 1, 2] },
    ],
  };
  const result = solve(problem, { findAll: true });
  const brute = enumerateSolutions(problem);
  assert.equal(result.status, 'SAT');
  assert.equal(result.solutions.length, brute.count);
  assert.ok(brute.count > 0);
  for (const s of result.solutions) assert.ok(checkAssignment(problem, s));
});

test('table constraint: UNSAT when table forces equal values under allDifferent', () => {
  const problem: Problem = {
    domains: [[1, 2], [1, 2]],
    constraints: [
      {
        kind: 'table',
        variables: [0, 1],
        tuples: [
          [1, 1],
          [2, 2],
        ],
      },
      { kind: 'allDifferent', variables: [0, 1] },
    ],
  };
  const result = solve(problem);
  assert.equal(result.status, 'UNSAT');
  assert.equal(enumerateSolutions(problem).count, 0);
  assert.ok(result.tree);
  for (const leaf of treeLeaves(result.tree!)) assert.equal(leaf.status, 'failed');
});

test('node budget: CUTOFF reports an unclosed, consistent frontier', () => {
  const problem: Problem = {
    domains: Array.from({ length: 6 }, () => [1, 2, 3, 4, 5, 6]),
    constraints: [{ kind: 'allDifferent', variables: [0, 1, 2, 3, 4, 5] }],
  };
  const budget = 3;
  const result = solve(problem, { budget });
  assert.equal(result.status, 'CUTOFF');
  assert.ok(result.nodes <= budget);
  assert.ok(result.frontier.length > 0, 'frontier must not be empty');
  for (const entry of result.frontier) {
    assert.ok(entry.candidates.length > 0);
    assert.ok(isPartialConsistent(problem, entry.path), 'frontier path is consistent');
    for (const c of entry.candidates) {
      assert.ok(problem.domains[entry.variable].includes(c));
    }
  }
  assert.ok(result.tree);
  assert.ok(collectStatuses(result.tree!).includes('open'), 'tree keeps open leaves');
});

test('node budget: sufficient budget finds a solution within the limit', () => {
  const result = solve(alldiff4, { budget: 100 });
  assert.equal(result.status, 'SAT');
  assert.ok(result.nodes <= 100);
  assert.ok(checkAssignment(alldiff4, result.solutions[0]));
});

test('node budget: findAll under budget returns partial solutions with CUTOFF', () => {
  const result = solve(alldiff4, { findAll: true, budget: 10 });
  assert.equal(result.status, 'CUTOFF');
  assert.ok(result.solutions.length > 0);
  assert.ok(result.solutions.length < 24);
  for (const s of result.solutions) assert.ok(checkAssignment(alldiff4, s));
  assert.ok(result.frontier.length > 0);
});

test('undo: every branch rollback restores all domains exactly', () => {
  const cases: { problem: Problem; options?: object }[] = [
    { problem: alldiff4 },
    {
      problem: {
        domains: [[1, 2, 3], [1, 2, 3], [1, 2, 3], [1, 2, 3]],
        constraints: [{ kind: 'allDifferent', variables: [0, 1, 2, 3] }],
      },
    },
    {
      problem: {
        domains: Array.from({ length: 6 }, () => [1, 2, 3, 4, 5, 6]),
        constraints: [{ kind: 'allDifferent', variables: [0, 1, 2, 3, 4, 5] }],
      },
      options: { budget: 2 },
    },
  ];
  for (const { problem, options } of cases) {
    const solver = new Solver(problem, options);
    const before = solver.currentDomains();
    solver.solve();
    assert.deepEqual(solver.currentDomains(), before);
    assert.deepEqual(
      solver.currentDomains(),
      solver.initialDomainCopies().map((d) => [...d].sort((a, b) => a - b)),
    );
  }
});

test('solver rejects more than 16 variables and accepts exactly 16', () => {
  const tooMany: Problem = {
    domains: Array.from({ length: MAX_VARIABLES + 1 }, () => [1]),
    constraints: [],
  };
  assert.throws(() => solve(tooMany), /at most 16 variables/);
  const exactlyMax: Problem = {
    domains: Array.from({ length: MAX_VARIABLES }, (_, i) => [i + 1]),
    constraints: [
      { kind: 'allDifferent', variables: Array.from({ length: MAX_VARIABLES }, (_, i) => i) },
    ],
  };
  const result = solve(exactlyMax);
  assert.equal(result.status, 'SAT');
  assert.deepEqual(result.solutions[0], Array.from({ length: MAX_VARIABLES }, (_, i) => i + 1));
});

test('invalid input is rejected', () => {
  assert.throws(
    () => solve({ domains: [[1, 1]], constraints: [] }),
    /duplicate values/,
  );
  assert.throws(
    () =>
      solve({
        domains: [[1], [2]],
        constraints: [{ kind: 'table', variables: [0, 1], tuples: [[1]] }],
      }),
    /arity/,
  );
  assert.throws(
    () =>
      solve({
        domains: [[1]],
        constraints: [{ kind: 'allDifferent', variables: [0, 5] }],
      }),
    /invalid variable index/,
  );
});

test('search is deterministic across runs', () => {
  const a = solve(alldiff4, { findAll: true });
  const b = solve(alldiff4, { findAll: true });
  assert.equal(a.nodes, b.nodes);
  assert.deepEqual(a.solutions, b.solutions);
});

test('integration: 4-queens via allDifferent + diagonal tables, count = 2', () => {
  const n = 4;
  const problem: Problem = {
    domains: Array.from({ length: n }, () => [0, 1, 2, 3]),
    constraints: [{ kind: 'allDifferent', variables: [0, 1, 2, 3] }],
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const tuples: number[][] = [];
      for (let a = 0; a < n; a++) {
        for (let b = 0; b < n; b++) {
          if (Math.abs(a - b) !== j - i) tuples.push([a, b]);
        }
      }
      problem.constraints.push({ kind: 'table', variables: [i, j], tuples });
    }
  }
  const result = solve(problem, { findAll: true });
  const brute = enumerateSolutions(problem);
  assert.equal(result.status, 'SAT');
  assert.equal(brute.count, 2);
  assert.equal(result.solutions.length, 2);
  for (const s of result.solutions) assert.ok(checkAssignment(problem, s));
});
