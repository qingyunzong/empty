'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize } = require('../src/model');
const { solve } = require('../src/solver');

// Brute-force optimum over every machine assignment and every per-machine
// permutation, using greedy earliest-start timing per sequence (optimal for
// a fixed sequence). Returns [makespan, totalSetup] or null if infeasible.
function bruteForce(model) {
  const { machineIds, setupTime, jobs } = model;
  let best = null;

  function* permutations(items) {
    if (items.length <= 1) {
      yield items.slice();
      return;
    }
    for (let i = 0; i < items.length; i++) {
      const rest = items.slice(0, i).concat(items.slice(i + 1));
      for (const p of permutations(rest)) yield [items[i], ...p];
    }
  }

  function* products(lists) {
    if (lists.length === 0) {
      yield [];
      return;
    }
    for (const head of lists[0]) {
      for (const tail of products(lists.slice(1))) yield [head, ...tail];
    }
  }

  function evaluate(sequences) {
    let makespan = 0;
    let setup = 0;
    for (const seq of sequences) {
      let t = 0;
      let prevFamily = null;
      for (const ji of seq) {
        const j = jobs[ji];
        const s = prevFamily === null || prevFamily === j.family ? 0 : setupTime;
        setup += prevFamily === null ? 0 : s;
        const start = Math.max(j.release, t + s);
        const end = start + j.duration;
        if (end > j.deadline) return null;
        t = end;
        prevFamily = j.family;
        if (end > makespan) makespan = end;
      }
    }
    return [makespan, setup];
  }

  const assign = new Array(jobs.length).fill(0);
  function recAssign(i) {
    if (i === jobs.length) {
      const groups = machineIds.map(() => []);
      assign.forEach((m, j) => groups[m].push(j));
      const perms = groups.map((g) => [...permutations(g)]);
      for (const combo of products(perms)) {
        const value = evaluate(combo);
        if (!value) continue;
        if (!best || value[0] < best[0] || (value[0] === best[0] && value[1] < best[1])) {
          best = value;
        }
      }
      return;
    }
    for (const m of jobs[i].machines) {
      assign[i] = machineIds.indexOf(m);
      recAssign(i + 1);
    }
  }
  recAssign(0);
  return best;
}

// Independent per-machine verification of a returned schedule.
function verifySchedule(model, result) {
  const { setupTime, jobs } = model;
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const seen = new Set();
  let makespan = 0;
  let totalSetup = 0;
  for (const machineSched of result.schedule) {
    let prevEnd = null;
    let prevFamily = null;
    for (const entry of machineSched.jobs) {
      const j = byId.get(entry.job);
      assert.ok(j, `unknown job ${entry.job}`);
      assert.ok(!seen.has(entry.job), `job ${entry.job} scheduled twice`);
      seen.add(entry.job);
      assert.ok(j.machines.includes(machineSched.machine), `job ${entry.job} not allowed on ${machineSched.machine}`);
      assert.ok(entry.start >= j.release, `job ${entry.job} starts before release`);
      assert.ok(entry.end === entry.start + j.duration, `job ${entry.job} bad end time`);
      assert.ok(entry.end <= j.deadline, `job ${entry.job} misses deadline`);
      assert.equal(entry.family, j.family);
      if (prevEnd !== null) {
        const s = prevFamily === entry.family ? 0 : setupTime;
        totalSetup += s;
        assert.ok(entry.start >= prevEnd + s, `overlap/setup violation before job ${entry.job} on ${machineSched.machine}`);
      }
      prevEnd = entry.end;
      prevFamily = entry.family;
      if (entry.end > makespan) makespan = entry.end;
    }
  }
  assert.equal(seen.size, jobs.length, 'not all jobs scheduled');
  assert.equal(result.makespan, makespan);
  assert.equal(result.totalSetup, totalSetup);
}

test('small feasible instance matches brute-force optimum', () => {
  const model = normalize({
    machines: ['M1', 'M2'],
    setupTime: 2,
    jobs: [
      { id: 'A', release: 0, duration: 3, deadline: 12, family: 'x' },
      { id: 'B', release: 1, duration: 2, deadline: 12, machines: ['M1'], family: 'y' },
      { id: 'C', release: 0, duration: 4, deadline: 14, machines: ['M2'], family: 'x' },
      { id: 'D', release: 2, duration: 2, deadline: 10, family: 'z' },
    ],
  });
  const optimum = bruteForce(model);
  assert.ok(optimum, 'brute force found no schedule');
  const result = solve(model, { budget: 100000 });
  assert.equal(result.status, 'optimal');
  verifySchedule(model, result);
  assert.equal(result.makespan, optimum[0], 'makespan must match brute-force optimum');
  assert.equal(result.totalSetup, optimum[1], 'total setup must match brute-force optimum');
});

test('second feasible instance with tight windows matches brute force', () => {
  const model = normalize({
    machines: ['M1', 'M2'],
    setupTime: 1,
    jobs: [
      { id: 'A', release: 0, duration: 2, deadline: 6, family: 'f1' },
      { id: 'B', release: 0, duration: 3, deadline: 7, family: 'f2' },
      { id: 'C', release: 1, duration: 1, deadline: 5, family: 'f1' },
      { id: 'D', release: 0, duration: 2, deadline: 8, machines: ['M2'], family: 'f2' },
    ],
  });
  const optimum = bruteForce(model);
  const result = solve(model, { budget: 100000 });
  assert.equal(result.status, 'optimal');
  verifySchedule(model, result);
  assert.deepEqual([result.makespan, result.totalSetup], optimum);
});

test('deadline conflict yields minimal conflict proof with jobs and machine constraints', () => {
  const model = normalize({
    machines: ['M1'],
    setupTime: 1,
    jobs: [
      { id: 'J1', release: 0, duration: 4, deadline: 5, family: 'p' },
      { id: 'J2', release: 0, duration: 4, deadline: 5, family: 'p' },
      { id: 'J3', release: 0, duration: 1, deadline: 100, family: 'q' },
    ],
  });
  const result = solve(model, { budget: 10000 });
  assert.equal(result.status, 'infeasible');
  const conflictJobIds = result.conflict.jobs.map((j) => j.id).sort();
  assert.deepEqual(conflictJobIds, ['J1', 'J2'], 'minimal conflict must contain exactly J1 and J2');
  assert.ok(
    result.conflict.machineConstraints.some((c) => c.machine === 'M1' && c.constraint === 'no-overlap'),
    'conflict must mention the machine non-overlap constraint'
  );
  const text = result.conflict.constraints.join('\n');
  assert.match(text, /job J1: release=0 deadline=5 duration=4/);
  assert.match(text, /job J2: release=0 deadline=5 duration=4/);
  assert.match(text, /machine M1: non-overlap/);
});

test('tiny budget returns unknown with pending variables, larger budget solves', () => {
  const raw = {
    machines: ['M1', 'M2'],
    setupTime: 2,
    jobs: [
      { id: 'A', release: 0, duration: 3, deadline: 12, family: 'x' },
      { id: 'B', release: 1, duration: 2, deadline: 12, machines: ['M1'], family: 'y' },
      { id: 'C', release: 0, duration: 4, deadline: 14, machines: ['M2'], family: 'x' },
      { id: 'D', release: 2, duration: 2, deadline: 10, family: 'z' },
    ],
  };
  const model = normalize(raw);

  const starved = solve(model, { budget: 0 });
  assert.equal(starved.status, 'unknown');
  assert.ok(starved.pendingVariables.length > 0, 'unknown must report pending variables');
  for (const pv of starved.pendingVariables) {
    assert.ok(Array.isArray(pv.machineDomain) && pv.machineDomain.length >= 1);
    assert.ok(Array.isArray(pv.startDomain) && pv.startDomain.length === 2);
  }
  assert.equal(starved.schedule, undefined, 'unknown must not claim a solution');

  const solved = solve(model, { budget: 100000 });
  assert.equal(solved.status, 'optimal');
  verifySchedule(model, solved);
});
