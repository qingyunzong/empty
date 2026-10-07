import test from 'node:test';
import assert from 'node:assert/strict';
import { solve } from '../src/solver.js';
import { bruteForceSolve } from '../src/bruteforce.js';

function mulberry32(seed) {
  let a = seed;
  return function rand() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInstance(rand) {
  const n = 1 + Math.floor(rand() * 8);
  const slots = 1 + Math.floor(rand() * 3);
  const capacity = 1 + Math.floor(rand() * 2);
  const instNames = ['A', 'B', 'C'].slice(0, 1 + Math.floor(rand() * 3));
  const quotas = {};
  for (const name of instNames) quotas[name] = 1 + Math.floor(rand() * 3);
  const instructions = [];
  for (let i = 0; i < n; i += 1) {
    const deps = [];
    for (let j = 0; j < i; j += 1) {
      if (rand() < 0.2 && deps.length < 2) deps.push(`i${j}`);
    }
    instructions.push({
      id: `i${i}`,
      institution: instNames[Math.floor(rand() * instNames.length)],
      amount: 1 + Math.floor(rand() * 50),
      priority: Math.floor(rand() * 6),
      deadline: 1 + Math.floor(rand() * slots),
      age: Math.floor(rand() * 3),
      deps: deps.sort(),
    });
  }
  return { instructions, slots, capacity, quotas, agingFactor: 1 };
}

const sortedEntries = (map) => [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));

test('solver matches independent brute-force optimum for n<=8', () => {
  const rand = mulberry32(20261007);
  for (let t = 0; t < 60; t += 1) {
    const instance = randomInstance(rand);
    const fast = solve(instance);
    const slow = bruteForceSolve(instance);
    assert.ok(fast.exact, `case ${t}: solver should be exact on small input`);
    assert.deepEqual(
      sortedEntries(fast.assignments),
      sortedEntries(slow.assignments),
      `case ${t} mismatch on ${JSON.stringify(instance)}`,
    );
  }
});

test('solver is deterministic across repeated runs', () => {
  const rand = mulberry32(7);
  for (let t = 0; t < 20; t += 1) {
    const instance = randomInstance(rand);
    const first = solve(instance);
    const second = solve(instance);
    assert.deepEqual(sortedEntries(first.assignments), sortedEntries(second.assignments));
  }
});

test('empty input yields an empty schedule', () => {
  const { assignments, exact } = solve({ instructions: [], slots: 2, capacity: 1, quotas: {}, agingFactor: 1 });
  assert.equal(exact, true);
  assert.equal(assignments.size, 0);
});
