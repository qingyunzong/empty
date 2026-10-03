import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solve } from '../src/solver.js';
import { bruteForce } from '../src/bruteforce.js';
import { canon } from '../src/canon.js';
import { rng, randomInstance } from './helpers.js';

test('acceptance 4: solver matches brute-force topological enumeration (n<=6)', () => {
  const rand = rng(20261003);
  for (let trial = 0; trial < 40; trial++) {
    const inst = randomInstance(rand, { n: 5, maxParams: 2, maxMachines: 2 });
    const expected = bruteForce(inst);
    const actual = solve(inst);
    assert.equal(actual.status, expected.status, `status mismatch trial ${trial}: ${canon(inst)}`);
    if (expected.status === 'SAT') {
      assert.equal(
        canon(actual.plan),
        canon(expected.plan),
        `plan mismatch trial ${trial}: ${canon(inst)}`,
      );
    }
  }
});

test('acceptance 4: n=6 with single machine', () => {
  const rand = rng(777);
  for (let trial = 0; trial < 10; trial++) {
    const inst = randomInstance(rand, { n: 6, maxParams: 2, maxMachines: 1 });
    const expected = bruteForce(inst);
    const actual = solve(inst);
    assert.equal(actual.status, expected.status, `status mismatch trial ${trial}`);
    if (expected.status === 'SAT') {
      assert.equal(canon(actual.plan), canon(expected.plan), `plan mismatch trial ${trial}`);
    }
  }
});

test('acceptance 4: n=8 chain-free instance, single param, single machine', () => {
  const rand = rng(42);
  const steps = [];
  for (let i = 0; i < 8; i++) {
    steps.push({ id: 's' + i, params: ['p0'], memory: Math.floor(rand() * 3), duration: 1 + Math.floor(rand() * 3) });
  }
  const edges = [];
  for (let i = 0; i < 8; i++) {
    for (let j = i + 1; j < 8; j++) {
      if (rand() < 0.25) edges.push(['s' + i, 's' + j]);
    }
  }
  const inst = { machines: 1, memoryLimit: 4, steps, edges, compat: [] };
  const expected = bruteForce(inst);
  const actual = solve(inst);
  assert.equal(actual.status, expected.status);
  assert.equal(canon(actual.plan), canon(expected.plan));
});

test('acceptance 4: pins agree with brute force', () => {
  const rand = rng(999);
  for (let trial = 0; trial < 20; trial++) {
    const inst = randomInstance(rand, { n: 5, maxParams: 2, maxMachines: 2 });
    const pins = { s0: inst.steps[0].params[0] };
    const expected = bruteForce(inst, pins);
    const actual = solve(inst, { pins });
    assert.equal(actual.status, expected.status, `status mismatch trial ${trial}`);
    if (expected.status === 'SAT') {
      assert.equal(canon(actual.plan), canon(expected.plan), `plan mismatch trial ${trial}`);
    }
  }
});
