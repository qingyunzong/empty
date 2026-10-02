'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { solve, minimalConflict } = require('../lib/solver');

function bruteForce(domains, target) {
  const rec = (i, sum) => (i === domains.length
    ? sum === target
    : domains[i].some((v) => rec(i + 1, sum + v)));
  return rec(0, 0);
}

function* cartesian(pools, n) {
  if (n === 0) { yield []; return; }
  for (const rest of cartesian(pools, n - 1)) {
    for (const p of pools) yield [...rest, p];
  }
}

test('solver matches brute-force enumeration for <= 3 centers', () => {
  const pools = [
    [0], [100], [10, 20, 30], [0, 50, 100],
    [25, 50, 75], [10, 40], [20, 30, 50, 70], [5, 15, 95],
  ];
  const targets = [0, 30, 100];
  for (let n = 1; n <= 3; n++) {
    for (const combo of cartesian(pools, n)) {
      const centers = combo.map((domain, i) => ({ id: `C${i}`, domain }));
      for (const target of targets) {
        const res = solve(centers, target, 1_000_000);
        const expected = bruteForce(combo, target);
        assert.equal(
          res.status === 'FEASIBLE', expected,
          `mismatch for ${JSON.stringify({ combo, target })}`,
        );
        if (res.status === 'FEASIBLE') {
          assert.equal(res.assignment.reduce((a, b) => a + b, 0), target);
          res.assignment.forEach((v, i) => assert.ok(combo[i].includes(v)));
        }
      }
    }
  }
});

test('budget exhaustion returns PENDING rather than UNSAT', () => {
  const centers = [
    { id: 'A', domain: [10, 20, 30, 40, 50] },
    { id: 'B', domain: [10, 20, 30, 40, 50] },
    { id: 'C', domain: [10, 20, 30, 40, 50] },
  ];
  assert.equal(solve(centers, 100, 0).status, 'PENDING');
  assert.equal(solve(centers, 100, 2).status, 'PENDING');
  assert.equal(solve(centers, 100, 1_000_000).status, 'FEASIBLE');
});

test('proven infeasibility with ample budget is UNSAT', () => {
  const centers = [
    { id: 'A', domain: [10, 20] },
    { id: 'B', domain: [10, 20] },
  ];
  const res = solve(centers, 100, 1_000_000);
  assert.equal(res.status, 'UNSAT');
});

test('minimalConflict returns a subset-minimal explanation', () => {
  const centers = [
    { id: 'A', domain: [60, 70] },
    { id: 'B', domain: [50, 60] },
    { id: 'C', domain: [10, 20] },
  ];
  assert.deepEqual(minimalConflict(centers), ['A', 'B']);
  const feasible = [
    { id: 'A', domain: [50] },
    { id: 'B', domain: [50] },
  ];
  assert.equal(minimalConflict(feasible), null);
});
