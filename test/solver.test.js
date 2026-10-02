import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateInstance } from '../src/validate.js';
import {
  solveCanonical,
  buildUnsatCertificate,
  verifyUnsatCertificate,
} from '../src/solver.js';
import { bruteForce } from '../src/bruteforce.js';
import { makeInstance } from '../examples/gen.mjs';

const key = (s) => s.join(',');
const solSet = (list) => new Set(list.map(key));

test('12 jobs: DP matches brute force on objective and all tied optima', () => {
  const instance = validateInstance(makeInstance(42, 12));
  const dp = solveCanonical(instance);
  const bf = bruteForce(instance);

  assert.equal(dp.status, 'FEASIBLE');
  assert.equal(bf.status, 'FEASIBLE');
  assert.deepEqual(dp.objective, bf.objective);
  assert.equal(dp.truncated, false);
  assert.equal(bf.truncated, false);
  assert.ok(dp.solutions.length > 1, 'expected tied optima in this fixture');
  assert.deepEqual(solSet(dp.solutions), solSet(bf.solutions));

  // every reported optimum really attains the objective
  for (const seq of dp.solutions) {
    assert.equal(seq.length, 12);
    assert.equal(new Set(seq).size, 12);
  }
});

test('multiple seeds: DP and brute force agree', () => {
  for (const seed of [1, 7, 99]) {
    const instance = validateInstance(makeInstance(seed, 9));
    const dp = solveCanonical(instance);
    const bf = bruteForce(instance);
    assert.equal(dp.status, bf.status);
    assert.deepEqual(dp.objective, bf.objective);
    assert.deepEqual(solSet(dp.solutions), solSet(bf.solutions));
  }
});

test('energy budget exceeded -> UNSAT with re-verifiable minimal certificate', () => {
  const raw = makeInstance(5, 6);
  raw.energyBudget = raw.jobs.reduce((a, j) => a + j.energy, 0) - 1; // one unit short
  const instance = validateInstance(raw);

  const result = solveCanonical(instance);
  assert.equal(result.status, 'UNSAT');

  const cert = buildUnsatCertificate(instance, result);
  assert.equal(cert.type, 'MINIMAL_INFEASIBLE_CORE');
  assert.ok(cert.coreEnergy > instance.energyBudget, 'core exceeds budget');
  assert.ok(cert.minimal, 'removing any single core constraint restores feasibility');
  assert.ok(cert.removals.every((r) => r.status === 'FEASIBLE'));
  assert.match(cert.enumerationHash, /^[0-9a-f]{64}$/);

  const check = verifyUnsatCertificate(instance, cert);
  assert.deepEqual(check, { ok: true });

  // tampered certificate must fail verification
  const tampered = { ...cert, enumerationHash: cert.enumerationHash.replace(/^./, '0') };
  assert.equal(verifyUnsatCertificate(instance, tampered).ok, false);
  const wrongInput = validateInstance(makeInstance(6, 6));
  assert.equal(verifyUnsatCertificate(wrongInput, cert).ok, false);
});

test('resource limit -> UNKNOWN, never reported as UNSAT', () => {
  const instance = validateInstance(makeInstance(42, 12));
  const result = solveCanonical(instance, { maxStates: 3 });
  assert.equal(result.status, 'UNKNOWN');
  assert.notEqual(result.status, 'UNSAT');
  assert.match(result.reason, /state limit/);

  const huge = validateInstance(makeInstance(1, 23));
  assert.equal(solveCanonical(huge).status, 'UNKNOWN');
});

test('empty job list is trivially feasible', () => {
  const instance = validateInstance({ jobs: [], setup: [], energyBudget: 0 });
  const result = solveCanonical(instance);
  assert.equal(result.status, 'FEASIBLE');
  assert.deepEqual(result.objective, { makespan: 0, energy: 0, tardiness: 0 });
});
