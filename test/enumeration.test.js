import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleJobs, computeHorizon } from '../src/schedule.js';
import { bruteForce } from '../src/reference.js';

// Deterministic PRNG (mulberry32)
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomCase(rand, n) {
  const nLines = 1 + Math.floor(rand() * 2);
  const lines = [];
  for (let i = 0; i < nLines; i++) {
    const shifts = [[480, 720]]; // 08:00-12:00
    if (rand() < 0.5) shifts.push([780, 1020]); // 13:00-17:00
    const maintenance = [];
    if (rand() < 0.4) maintenance.push([1440 + 480 + Math.floor(rand() * 120), 60]);
    lines.push({ name: `L${i}`, shifts, maintenance });
  }
  const jobs = [];
  for (let j = 0; j < n; j++) {
    const duration = 15 + 15 * Math.floor(rand() * 6); // 15..90
    const priority = 1 + Math.floor(rand() * 5);
    const restricted = nLines > 1 && rand() < 0.3;
    jobs.push({
      id: `J${j}`,
      duration,
      priority,
      lines: restricted ? [`L${Math.floor(rand() * nLines)}`] : null,
    });
  }
  return { jobs, lines };
}

function placementsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w || w.line !== v.line || w.start !== v.start) return false;
  }
  return true;
}

test('exact scheduler matches brute-force enumeration for <= 7 jobs', () => {
  let checked = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const rand = rng(seed);
    const n = 1 + (seed % 7); // 1..7 jobs
    const { jobs, lines } = randomCase(rand, n);
    const horizon = computeHorizon(jobs, lines);
    const got = scheduleJobs(jobs, lines);
    const want = bruteForce(jobs, lines, horizon);
    if (want === null) {
      assert.equal(got, null, `seed=${seed}: expected infeasible`);
      continue;
    }
    assert.ok(got !== null, `seed=${seed}: expected feasible`);
    assert.ok(
      placementsEqual(got.placement, want.placement),
      `seed=${seed}: placement mismatch vs brute force`);
    checked++;
  }
  assert.ok(checked >= 30, `too few feasible cases: ${checked}`);
});

test('tied priorities are broken deterministically by job id', () => {
  const lines = [{ name: 'A', shifts: [[480, 960]], maintenance: [] }];
  const jobs = [
    { id: 'J2', duration: 60, priority: 5, lines: null },
    { id: 'J1', duration: 60, priority: 5, lines: null },
    { id: 'J3', duration: 60, priority: 5, lines: null },
  ];
  const r = scheduleJobs(jobs, lines);
  const starts = [...r.placement.entries()].sort((x, y) => x[1].start - y[1].start);
  assert.deepEqual(starts.map(([id]) => id), ['J1', 'J2', 'J3']);
  // and it agrees with the reference
  const want = bruteForce(jobs, lines, computeHorizon(jobs, lines));
  assert.ok(placementsEqual(r.placement, want.placement));
});

test('higher priority jobs are scheduled earlier (weighted completion)', () => {
  const lines = [{ name: 'A', shifts: [[480, 960]], maintenance: [] }];
  const jobs = [
    { id: 'low', duration: 60, priority: 1, lines: null },
    { id: 'high', duration: 60, priority: 9, lines: null },
  ];
  const r = scheduleJobs(jobs, lines);
  assert.ok(r.placement.get('high').start < r.placement.get('low').start);
});

test('maintenance windows are avoided', () => {
  const lines = [{ name: 'A', shifts: [[480, 960]], maintenance: [[540, 120]] }]; // 09:00-11:00 blocked
  const jobs = [{ id: 'J1', duration: 90, priority: 1, lines: null }];
  const r = scheduleJobs(jobs, lines);
  const { start } = r.placement.get('J1');
  const end = start + 90;
  assert.ok(end <= 540 || start >= 660, `job overlaps maintenance: [${start}, ${end})`);
});
