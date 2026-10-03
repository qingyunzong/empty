'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validateInstance } = require('../src/model');
const { solve } = require('../src/solver');
const { verifySchedule } = require('../src/verify');
const { runCli } = require('../src/cli');

// Exact brute-force optimum: enumerate every machine assignment and every
// per-machine permutation; schedule each order as early as possible.
function bruteForceOptimum(instance) {
  const { machines, jobs, setupTime } = instance;
  let best = null;

  function* permutations(items) {
    if (items.length <= 1) { yield items.slice(); return; }
    for (let i = 0; i < items.length; i++) {
      const rest = items.slice(0, i).concat(items.slice(i + 1));
      for (const p of permutations(rest)) yield [items[i], ...p];
    }
  }

  function* assignments(i, current) {
    if (i === jobs.length) { yield current; return; }
    for (const m of jobs[i].machines) {
      current.push(m);
      yield* assignments(i + 1, current);
      current.pop();
    }
  }

  function* orderProduct(lists, i, current) {
    if (i === lists.length) { yield current; return; }
    for (const perm of permutations(lists[i])) {
      current.push(perm);
      yield* orderProduct(lists, i + 1, current);
      current.pop();
    }
  }

  for (const assign of assignments(0, [])) {
    const perMachine = machines.map((m) =>
      jobs.map((j, idx) => (assign[idx] === m ? idx : -1)).filter((idx) => idx >= 0));
    for (const orders of orderProduct(perMachine, 0, [])) {
      let makespan = 0;
      let totalSetup = 0;
      let feasible = true;
      for (const order of orders) {
        let prevEnd = null;
        let prevIdx = -1;
        for (const idx of order) {
          const job = jobs[idx];
          let start = job.release;
          if (prevEnd !== null) {
            const gap = jobs[prevIdx].family === job.family ? 0 : setupTime;
            start = Math.max(start, prevEnd + gap);
            totalSetup += gap;
          }
          const end = start + job.duration;
          if (end > job.deadline) { feasible = false; break; }
          makespan = Math.max(makespan, end);
          prevEnd = end;
          prevIdx = idx;
        }
        if (!feasible) break;
      }
      if (!feasible) continue;
      const cand = { makespan, totalSetup };
      if (!best || cand.makespan < best.makespan ||
          (cand.makespan === best.makespan && cand.totalSetup < best.totalSetup)) {
        best = cand;
      }
    }
  }
  return best;
}

const INSTANCE_A = validateInstance({
  machines: ['M1', 'M2'],
  setupTime: 2,
  jobs: [
    { id: 'A', release: 0, deadline: 12, duration: 3, family: 'F1' },
    { id: 'B', release: 1, deadline: 12, duration: 2, family: 'F2' },
    { id: 'C', release: 0, deadline: 12, duration: 4, family: 'F1' },
  ],
});

const INSTANCE_B = validateInstance({
  machines: ['M1', 'M2'],
  setupTime: 1,
  jobs: [
    { id: 'D', release: 0, deadline: 9, duration: 2, family: 'X', machines: ['M1'] },
    { id: 'E', release: 2, deadline: 10, duration: 3, family: 'Y' },
    { id: 'F', release: 0, deadline: 8, duration: 2, family: 'X', machines: ['M2'] },
    { id: 'G', release: 1, deadline: 11, duration: 1, family: 'Y' },
  ],
});

test('optimal solution matches brute-force enumeration (instance A)', () => {
  const result = solve(INSTANCE_A, { budget: 100000 });
  assert.equal(result.status, 'optimal');
  const expected = bruteForceOptimum(INSTANCE_A);
  assert.ok(expected, 'brute force found a feasible solution');
  assert.equal(result.objective.makespan, expected.makespan);
  assert.equal(result.objective.totalSetup, expected.totalSetup);
  const check = verifySchedule(INSTANCE_A, result.schedule);
  assert.deepEqual(check.errors, []);
  assert.ok(check.ok);
});

test('optimal solution matches brute-force enumeration (instance B, restricted machines)', () => {
  const result = solve(INSTANCE_B, { budget: 100000 });
  assert.equal(result.status, 'optimal');
  const expected = bruteForceOptimum(INSTANCE_B);
  assert.ok(expected, 'brute force found a feasible solution');
  assert.equal(result.objective.makespan, expected.makespan);
  assert.equal(result.objective.totalSetup, expected.totalSetup);
  const check = verifySchedule(INSTANCE_B, result.schedule);
  assert.deepEqual(check.errors, []);
  assert.ok(check.ok);
});

test('deadline conflict yields conflict proof naming jobs and machine', () => {
  const instance = validateInstance({
    machines: ['M1'],
    setupTime: 0,
    jobs: [
      { id: 'J1', release: 0, deadline: 4, duration: 3, machines: ['M1'] },
      { id: 'J2', release: 0, deadline: 5, duration: 3, machines: ['M1'] },
    ],
  });
  const result = solve(instance, { budget: 100000 });
  assert.equal(result.status, 'unsat');
  assert.ok(result.conflict, 'conflict proof present');
  const ids = result.conflict.jobs.map((j) => j.id).sort();
  assert.deepEqual(ids, ['J1', 'J2']);
  const j1 = result.conflict.jobs.find((j) => j.id === 'J1');
  assert.equal(j1.deadline, 4);
  assert.equal(j1.duration, 3);
  assert.ok(
    result.conflict.machineConstraints.some((c) => c.includes('M1')),
    'conflict mentions machine M1');
});

test('tiny budget returns unknown with pending variables, larger budget solves', () => {
  const tight = solve(INSTANCE_A, { budget: 0 });
  assert.equal(tight.status, 'unknown');
  assert.ok(Array.isArray(tight.pendingVariables));
  assert.ok(tight.pendingVariables.length > 0, 'pending variables reported');
  assert.ok(tight.pendingVariables.some((v) => v.variable === 'machine'));

  const ample = solve(INSTANCE_A, { budget: 100000 });
  assert.equal(ample.status, 'optimal');
});

test('budget exhaustion never reports unsat', () => {
  // Infeasible only by pigeonhole over machine assignment (3 jobs, 2 machines,
  // at most one job per machine), so proving unsat requires branching.
  const unsatInstance = validateInstance({
    machines: ['M1', 'M2'],
    setupTime: 0,
    jobs: [
      { id: 'J1', release: 0, deadline: 5, duration: 3 },
      { id: 'J2', release: 0, deadline: 5, duration: 3 },
      { id: 'J3', release: 0, deadline: 5, duration: 3 },
    ],
  });
  const starved = solve(unsatInstance, { budget: 0 });
  assert.equal(starved.status, 'unknown');
  assert.ok(starved.pendingVariables.length > 0);

  const proven = solve(unsatInstance, { budget: 100000 });
  assert.equal(proven.status, 'unsat');
  assert.deepEqual(proven.conflict.jobs.map((j) => j.id).sort(), ['J1', 'J2', 'J3']);
});

// ---- CLI tests ----

function writeTmp(obj) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sched-')), 'input.json');
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

test('CLI schedules a feasible instance (exit 0, verifiable schedule)', () => {
  const file = writeTmp({
    machines: ['M1', 'M2'],
    setupTime: 2,
    jobs: [
      { id: 'A', release: 0, deadline: 12, duration: 3, family: 'F1' },
      { id: 'B', release: 1, deadline: 12, duration: 2, family: 'F2' },
      { id: 'C', release: 0, deadline: 12, duration: 4, family: 'F1' },
    ],
  });
  const run = runCli(['schedule', file, '--budget', '1000']);
  assert.equal(run.code, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.status, 'optimal');
  const check = verifySchedule(INSTANCE_A, out.schedule);
  assert.ok(check.ok, check.errors.join('; '));
});

test('CLI exits 2 when input file is missing', () => {
  const run = runCli(['schedule', '/nonexistent/input.json', '--budget', '10']);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /cannot read input file/);
});

test('CLI exits 2 on non-integer time', () => {
  const file = writeTmp({
    machines: ['M1'],
    jobs: [{ id: 'A', release: 0.5, deadline: 5, duration: 2 }],
  });
  const run = runCli(['schedule', file]);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /release must be an integer/);
});

test('CLI exits 2 on undefined machine', () => {
  const file = writeTmp({
    machines: ['M1'],
    jobs: [{ id: 'A', release: 0, deadline: 5, duration: 2, machines: ['M9'] }],
  });
  const run = runCli(['schedule', file]);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /undefined machine/);
});

test('CLI reports unknown under tiny budget and unsat conflict when infeasible', () => {
  // Needs branching to resolve, so budget 0 must yield unknown (never unsat).
  const pigeonholeFile = writeTmp({
    machines: ['M1', 'M2'],
    jobs: [
      { id: 'J1', release: 0, deadline: 5, duration: 3 },
      { id: 'J2', release: 0, deadline: 5, duration: 3 },
      { id: 'J3', release: 0, deadline: 5, duration: 3 },
    ],
  });
  const unknown = runCli(['schedule', pigeonholeFile, '--budget', '0']);
  assert.equal(unknown.code, 0, unknown.stderr);
  const unknownOut = JSON.parse(unknown.stdout);
  assert.equal(unknownOut.status, 'unknown');
  assert.ok(unknownOut.pendingVariables.length > 0);

  const conflictFile = writeTmp({
    machines: ['M1'],
    jobs: [
      { id: 'J1', release: 0, deadline: 4, duration: 3 },
      { id: 'J2', release: 0, deadline: 5, duration: 3 },
    ],
  });

  const unsat = runCli(['schedule', conflictFile, '--budget', '1000']);
  assert.equal(unsat.code, 0, unsat.stderr);
  const out = JSON.parse(unsat.stdout);
  assert.equal(out.status, 'unsat');
  assert.deepEqual(out.conflict.jobs.map((j) => j.id).sort(), ['J1', 'J2']);
  assert.ok(out.conflict.machineConstraints.some((c) => c.includes('M1')));
});
