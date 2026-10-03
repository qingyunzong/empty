import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate, optimize, permutations, mergeBlocked } from '../src/scheduler.js';

const MIN = 60_000;
const T0 = 1_700_000_000_000;

function makeJobs(specs) {
  const m = new Map();
  for (const [job, mold, qty, op, due] of specs) {
    m.set(job, { job, mold, qty, op, due: due ?? T0 + 8 * 3600 * 1000 });
  }
  return m;
}

test('simulate inserts changeover and joins maintenance windows', () => {
  const jobs = makeJobs([['J1', 'A', 10, 1], ['J2', 'B', 10, 1]]);
  const blocked = mergeBlocked([[T0 + 35 * MIN, T0 + 45 * MIN]]);
  const r = simulate(['J1', 'J2'], jobs, blocked, T0, 30 * MIN);
  // changeover [T0, T0+30), J1 [T0+30, T0+40) overlaps maint [35,45) -> pushed to [45,55)
  assert.equal(r.placed[0].start, T0 + 45 * MIN);
  assert.equal(r.placed[0].end, T0 + 55 * MIN);
  // J2 needs mold changeover 30m starting at 55m
  assert.equal(r.placed[1].changeover.start, T0 + 55 * MIN);
  assert.equal(r.placed[1].start, T0 + 85 * MIN);
  assert.equal(r.energy, 2);
  assert.equal(r.makespan, T0 + 95 * MIN);
});

test('tied optima are all emitted, sorted by job lexicographic order', () => {
  const jobs = makeJobs([['J1', 'A', 5, 1], ['J2', 'B', 5, 1], ['J3', 'A', 5, 1]]);
  const r = optimize(jobs, [], T0, { changeoverMin: 30 * MIN });
  assert.equal(r.objective.energy, 2);
  assert.equal(r.totalOptimal, 4);
  assert.deepEqual(
    r.schedules.map((s) => s.map((p) => p.job)),
    [['J1', 'J3', 'J2'], ['J2', 'J1', 'J3'], ['J2', 'J3', 'J1'], ['J3', 'J1', 'J2']],
  );
});

// Acceptance 3: enumerate every permutation of <=8-job cases and compare
// the full tied-optimal set against an independent brute-force oracle.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function bruteForceOptimal(jobs, blocked, t0, changeoverMin) {
  const ids = [...jobs.keys()];
  let best = null;
  const ties = [];
  for (const p of permutations(ids)) {
    const r = simulate(p, jobs, blocked, t0, changeoverMin);
    const key = [r.tardy, r.makespan, r.energy];
    const cmp = best === null ? -1
      : key[0] !== best[0] ? key[0] - best[0]
      : key[1] !== best[1] ? key[1] - best[1]
      : key[2] - best[2];
    if (cmp < 0) {
      best = key;
      ties.length = 0;
      ties.push(p);
    } else if (cmp === 0) {
      ties.push(p);
    }
  }
  ties.sort((a, b) => a.join('').localeCompare(b.join('')));
  return { best, ties };
}

test('exhaustive <=8-job cases match brute-force tied optima', () => {
  const rand = lcg(20261003);
  const molds = ['A', 'B', 'C'];
  for (let trial = 0; trial < 12; trial += 1) {
    const n = 1 + Math.floor(rand() * 8); // 1..8 jobs
    const specs = [];
    for (let i = 0; i < n; i += 1) {
      const mold = molds[Math.floor(rand() * molds.length)];
      const qty = 1 + Math.floor(rand() * 4);
      const op = 1 + Math.floor(rand() * 3);
      const loose = rand() < 0.7;
      const due = loose ? T0 + 8 * 3600 * 1000 : T0 + Math.floor(rand() * 120) * MIN;
      specs.push([`J${i}`, mold, qty, op, due]);
    }
    const jobs = makeJobs(specs);
    const blocked = [];
    if (rand() < 0.5) {
      const s = T0 + Math.floor(rand() * 60) * MIN;
      blocked.push([s, s + (5 + Math.floor(rand() * 20)) * MIN]);
    }
    const changeoverMin = 30 * MIN;
    const got = optimize(jobs, blocked, T0, { changeoverMin });
    const want = bruteForceOptimal(jobs, mergeBlocked(blocked), T0, changeoverMin);
    assert.deepEqual(
      [got.objective.tardy, got.objective.makespan, got.objective.energy],
      want.best,
      `trial ${trial}: objective mismatch`,
    );
    const gotSeqs = got.schedules.map((s) => s.map((p) => p.job));
    if (want.ties.length <= 500) {
      assert.equal(got.truncated, false);
      assert.equal(got.totalOptimal, want.ties.length);
      assert.deepEqual(gotSeqs, want.ties, `trial ${trial}: tied set mismatch`);
    } else {
      assert.equal(got.truncated, true);
      const wantSet = new Set(want.ties.map((t) => t.join(',')));
      for (const s of gotSeqs) assert.ok(wantSet.has(s.join(',')));
    }
  }
});
