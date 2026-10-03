import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solve } from '../src/solver.js';
import { canon } from '../src/canon.js';
import { initState, solveState, pin, unpin, insertJob } from '../src/state.js';
import { rng, randomInstance } from './helpers.js';

test('acceptance 2: incremental pin/unpin results equal full recomputation', () => {
  const rand = rng(31337);
  for (let trial = 0; trial < 15; trial++) {
    const inst = randomInstance(rand, { n: 5, maxParams: 2, maxMachines: 2 });
    const state = initState(inst);
    const base = solveState(state);
    assert.equal(canon(base), canon(strip(solve(inst))), `baseline mismatch trial ${trial}`);

    // Pin every step to its first param, one at a time, checking each step.
    const pins = {};
    for (const s of inst.steps) {
      const value = s.params[0];
      pins[s.id] = value;
      const inc = pin(state, s.id, value);
      const fresh = solve(inst, { pins: { ...pins } });
      assert.equal(canon(strip(inc)), canon(strip(fresh)), `pin mismatch trial ${trial} step ${s.id}`);
    }
    // Unpin in reverse order.
    for (const s of [...inst.steps].reverse()) {
      delete pins[s.id];
      const inc = unpin(state, s.id);
      const fresh = solve(inst, { pins: { ...pins } });
      assert.equal(canon(strip(inc)), canon(strip(fresh)), `unpin mismatch trial ${trial} step ${s.id}`);
    }
    // Back to baseline.
    assert.equal(canon(state.lastSolve), canon(strip(solve(inst))), `final mismatch trial ${trial}`);
  }
});

test('acceptance 2: insert_job then pin matches recomputation on extended instance', () => {
  const inst = {
    machines: 2,
    memoryLimit: 4,
    steps: [
      { id: 'a', params: ['x', 'y'], memory: 1, duration: 2 },
      { id: 'b', params: ['u'], memory: 2, duration: 1 },
    ],
    edges: [['a', 'b']],
    compat: [],
  };
  const state = initState(inst);
  solveState(state);
  const job = { id: 'c', params: ['p'], memory: 1, duration: 1 };
  const r1 = insertJob(state, job);
  const extended = { ...inst, steps: [...inst.steps, job] };
  assert.equal(canon(strip(r1)), canon(strip(solve(extended))));
  const r2 = pin(state, 'a', 'y');
  assert.equal(canon(strip(r2)), canon(strip(solve(extended, { pins: { a: 'y' } }))));
});

test('pin validation errors are INVALID_INPUT', () => {
  const inst = {
    machines: 1,
    memoryLimit: 1,
    steps: [{ id: 'a', params: ['x'], memory: 1, duration: 1 }],
  };
  const state = initState(inst);
  assert.throws(() => pin(state, 'nope', 'x'), /unknown step/);
  assert.throws(() => pin(state, 'a', 'nope'), /not in domain/);
  assert.throws(() => unpin(state, 'a'), /not pinned/);
});

function strip(result) {
  // Compare the observable outcome, not the certificate chain (which is
  // expected to differ between incremental and fresh runs).
  return { status: result.status, plan: result.plan };
}
