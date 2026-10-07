'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { solve, prepareInput, MAX_JOBS } = require('../src/scheduler');
const { bruteForce, plansMatch } = require('../src/verify');
const { SchedError } = require('../src/errors');

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInput(rnd, maxJobs) {
  const n = 1 + Math.floor(rnd() * maxJobs);
  const devices = [
    { id: 'M1', capacity: rnd() < 0.3 ? 6 + Math.floor(rnd() * 10) : null },
    { id: 'M2', capacity: rnd() < 0.3 ? 6 + Math.floor(rnd() * 10) : null },
  ];
  const jobs = [];
  for (let i = 0; i < n; i++) {
    const release = Math.floor(rnd() * 8);
    const duration = 1 + Math.floor(rnd() * 5);
    const due = release + duration + Math.floor(rnd() * 8) - 2;
    const restricted = rnd() < 0.25 ? [['M1'], ['M2']][Math.floor(rnd() * 2)] : null;
    jobs.push({ id: 'J' + (i + 1), release, due, duration, ...(restricted ? { devices: restricted } : {}) });
  }
  return { jobs, devices };
}

function validatePlan(input, plan) {
  const { jobs, devices } = prepareInput(input);
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const seen = new Set();
  let objective = -Infinity;
  for (const d of devices) {
    const ops = plan.schedule[d.id];
    assert.ok(Array.isArray(ops), `schedule missing device ${d.id}`);
    let t = 0;
    for (const op of ops) {
      const job = byId.get(op.jobId);
      assert.ok(job, `unknown job ${op.jobId}`);
      assert.ok(!seen.has(op.jobId), `job ${op.jobId} scheduled twice`);
      seen.add(op.jobId);
      if (job.devices !== null) assert.ok(job.devices.includes(d.id), `job ${op.jobId} not eligible on ${d.id}`);
      assert.ok(op.start >= Math.max(t, job.release), `job ${op.jobId} starts too early`);
      assert.equal(op.end - op.start, job.duration);
      if (d.capacity !== null) assert.ok(op.end <= d.capacity, `job ${op.jobId} exceeds capacity of ${d.id}`);
      objective = Math.max(objective, op.end - job.due);
      t = op.end;
    }
  }
  assert.equal(seen.size, jobs.length, 'every job must be scheduled exactly once');
  assert.equal(plan.objective, jobs.length === 0 ? 0 : objective);
  const assigned = new Map(plan.assignments.map((a) => [a.jobId, a.deviceId]));
  for (const d of devices) {
    for (const op of plan.schedule[d.id]) assert.equal(assigned.get(op.jobId), d.id);
  }
}

test('acceptance 1: DP plan matches independent exhaustive DFS for <=4 jobs', () => {
  let feasible = 0;
  let infeasible = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const input = randomInput(mulberry32(seed), 4);
    let dp;
    let dfs;
    let dpErr = null;
    let dfsErr = null;
    try {
      dp = solve(input);
    } catch (e) {
      dpErr = e;
    }
    try {
      dfs = bruteForce(input);
    } catch (e) {
      dfsErr = e;
    }
    if (dpErr || dfsErr) {
      assert.ok(dpErr && dfsErr, `seed ${seed}: only one side failed`);
      assert.equal(dpErr.code, dfsErr.code, `seed ${seed}`);
      assert.deepEqual(dpErr.details, dfsErr.details, `seed ${seed}`);
      infeasible++;
      continue;
    }
    const result = plansMatch(dp, dfs);
    assert.ok(result.match, `seed ${seed}: ${result.diffs.join('; ')}`);
    feasible++;
  }
  assert.ok(feasible > 200, `expected many feasible instances, got ${feasible}`);
  assert.ok(infeasible > 0, 'expected at least one infeasible instance in the sample');
});

test('certificate carries input hash, objective and tie-break rank', () => {
  const input = {
    jobs: [
      { id: 'J1', release: 0, due: 6, duration: 3 },
      { id: 'J2', release: 1, due: 5, duration: 2, devices: ['M1'] },
      { id: 'J3', release: 0, due: 10, duration: 4 },
      { id: 'J4', release: 2, due: 8, duration: 2 },
    ],
  };
  const a = solve(input);
  const b = solve({ jobs: [...input.jobs].reverse() });
  assert.equal(typeof a.certificate.inputHash, 'string');
  assert.equal(a.certificate.inputHash.length, 64);
  assert.equal(a.certificate.objective, a.objective);
  assert.ok(Number.isInteger(a.certificate.tieCount) && a.certificate.tieCount >= 1);
  assert.ok(a.certificate.tieRank >= 1 && a.certificate.tieRank <= a.certificate.tieCount);
  // Deterministic and insensitive to input job order.
  assert.deepEqual(a, b);
});

test('E_INFEASIBLE reports the first unschedulable jobId', () => {
  assert.throws(
    () => solve({ jobs: [{ id: 'J2', release: 0, due: 1, duration: 1, devices: [] }] }),
    (e) => e instanceof SchedError && e.code === 'E_INFEASIBLE' && e.details.jobId === 'J2'
  );
  assert.throws(
    () =>
      solve({
        jobs: [
          { id: 'A', release: 0, due: 10, duration: 2 },
          { id: 'B', release: 5, due: 10, duration: 2, devices: ['M1'] },
        ],
        devices: [{ id: 'M1', capacity: 6 }, { id: 'M2' }],
      }),
    (e) => e.code === 'E_INFEASIBLE' && e.details.jobId === 'B'
  );
  // Aggregate capacity shortage: every job fits alone, together they do not.
  assert.throws(
    () =>
      solve({
        jobs: [
          { id: 'A', release: 0, due: 10, duration: 3 },
          { id: 'B', release: 0, due: 10, duration: 3 },
        ],
        devices: [{ id: 'M1', capacity: 4 }, { id: 'M2', capacity: 1 }],
      }),
    (e) => e.code === 'E_INFEASIBLE' && e.details.jobId === 'A'
  );
});

test('invalid input is rejected with E_INVALID', () => {
  assert.throws(() => solve({ jobs: [{ id: 'X', release: 0, due: 1, duration: 0 }] }), /duration/);
  assert.throws(
    () =>
      solve({
        jobs: [
          { id: 'X', release: 0, due: 1, duration: 1 },
          { id: 'X', release: 0, due: 1, duration: 1 },
        ],
      }),
    /duplicate/
  );
  assert.throws(
    () => solve({ jobs: [{ id: 'X', release: 0, due: 1, duration: 1, devices: ['M9'] }] }),
    /unknown device/
  );
  assert.throws(
    () =>
      solve({
        jobs: Array.from({ length: MAX_JOBS + 1 }, (_, i) => ({ id: 'J' + i, release: 0, due: 1, duration: 1 })),
      }),
    /at most/
  );
});

test('exact optimum on a hand-checked instance', () => {
  const input = {
    jobs: [
      { id: 'J1', release: 0, due: 4, duration: 2 },
      { id: 'J2', release: 0, due: 6, duration: 3 },
      { id: 'J3', release: 0, due: 8, duration: 2 },
    ],
  };
  const plan = solve(input);
  // J1(2)+J3(2) on one machine finish at 4 -> lateness max(-2,-4)=-2;
  // J2 alone finishes at 3 -> -3. Lmax = -2.
  assert.equal(plan.objective, -2);
  validatePlan(input, plan);
});

test('scales to 20 jobs deterministically', () => {
  const input = randomInput(mulberry32(42), 20);
  while (input.jobs.length < 20) {
    input.jobs.push({ id: 'JX' + input.jobs.length, release: 0, due: 100, duration: 2 });
  }
  input.devices = [{ id: 'M1' }, { id: 'M2' }];
  const a = solve(input);
  const b = solve(input);
  assert.deepEqual(a, b);
  validatePlan(input, a);
});
