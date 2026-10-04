import test from 'node:test';
import assert from 'node:assert/strict';
import {
  schedule,
  enumeratePlans,
  tieRankAndCount,
  comparePlans,
  normalizeJobs,
  normalizeDevices,
  ScheduleError,
} from '../src/scheduler.js';
import { canonicalize, sha256 } from '../src/util.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomJobs(rng, n, devices) {
  const jobs = [];
  for (let i = 0; i < n; i += 1) {
    const release = Math.floor(rng() * 7);
    const duration = 1 + Math.floor(rng() * 4);
    const due = release + Math.floor(rng() * 12);
    const job = { id: `J${i + 1}`, release, due, duration };
    const pick = rng();
    if (pick < 0.25) job.devices = [devices[0]];
    else if (pick < 0.5) job.devices = [devices[1]];
    jobs.push(job);
  }
  return jobs;
}

test('schedule matches exhaustive DFS enumeration for <=4 jobs', () => {
  const rng = mulberry32(20261004);
  const devices = ['M1', 'M2'];
  for (let iter = 0; iter < 200; iter += 1) {
    const n = 1 + Math.floor(rng() * 4);
    const jobs = randomJobs(rng, n, devices);
    const result = schedule(jobs, devices);

    const normJobs = normalizeJobs(jobs, devices);
    const normDevices = normalizeDevices(devices);
    const all = enumeratePlans(normJobs, normDevices);
    const ref = all.reduce((best, p) => (comparePlans(p, best) < 0 ? p : best));
    const { tieRank, optimalCount } = tieRankAndCount(all, ref);

    assert.equal(result.objective, ref.objective, `objective mismatch iter=${iter}`);
    assert.deepEqual(
      result.entries,
      ref.entries,
      `plan mismatch iter=${iter} jobs=${JSON.stringify(jobs)}`,
    );

    const cert = result.certificate;
    assert.equal(cert.inputHash, sha256(canonicalize({ devices: normDevices, jobs: normJobs })));
    assert.equal(cert.objective, ref.objective);
    assert.equal(cert.tieRank, tieRank);
    assert.equal(cert.optimalCount, optimalCount);
    assert.ok(tieRank >= 1 && tieRank <= optimalCount);
  }
});

test('release dates allow beneficial idle insertion via reordering', () => {
  const jobs = [
    { id: 'A', release: 0, due: 100, duration: 10 },
    { id: 'B', release: 1, due: 2, duration: 1 },
  ];
  const result = schedule(jobs, ['M1']);
  assert.equal(result.objective, 0);
  assert.deepEqual(
    result.entries.map((e) => e.jobId),
    ['B', 'A'],
  );
  assert.deepEqual(result.entries[0], { jobId: 'B', deviceId: 'M1', start: 1, end: 2 });
});

test('device restrictions are honored', () => {
  const jobs = [
    { id: 'A', release: 0, due: 5, duration: 3, devices: ['M1'] },
    { id: 'B', release: 0, due: 5, duration: 3, devices: ['M2'] },
  ];
  const result = schedule(jobs, ['M1', 'M2']);
  const byJob = Object.fromEntries(result.entries.map((e) => [e.jobId, e.deviceId]));
  assert.equal(byJob.A, 'M1');
  assert.equal(byJob.B, 'M2');
});

test('E_INFEASIBLE reports first unschedulable jobId in sorted order', () => {
  const jobs = [
    { id: 'Z', release: 0, due: 5, duration: 1, devices: [] },
    { id: 'A', release: 0, due: 5, duration: 1, devices: [] },
  ];
  assert.throws(() => schedule(jobs, ['M1', 'M2']), (err) => {
    assert.ok(err instanceof ScheduleError);
    assert.equal(err.code, 'E_INFEASIBLE');
    assert.equal(err.jobId, 'A');
    return true;
  });
});

test('E_INFEASIBLE when capacity exceeded (>20 jobs)', () => {
  const jobs = Array.from({ length: 21 }, (_, i) => ({
    id: `J${String(i + 1).padStart(2, '0')}`,
    release: 0,
    due: 100,
    duration: 1,
  }));
  assert.throws(() => schedule(jobs, ['M1', 'M2']), (err) => {
    assert.equal(err.code, 'E_INFEASIBLE');
    assert.equal(err.jobId, 'J21');
    return true;
  });
});

test('invalid input raises E_INVALID', () => {
  assert.throws(() => schedule([{ id: 'A', release: 0, due: 1, duration: 0 }]), /duration/);
  assert.throws(() => schedule([{ id: 'A', release: 0, due: 1, duration: 1, devices: ['XX'] }]), (err) => {
    assert.equal(err.code, 'E_INVALID');
    return true;
  });
  assert.throws(
    () =>
      schedule([
        { id: 'A', release: 0, due: 1, duration: 1 },
        { id: 'A', release: 0, due: 1, duration: 1 },
      ]),
    (err) => err.code === 'E_INVALID',
  );
});

test('deterministic: identical inputs give identical output', () => {
  const rng = mulberry32(7);
  const jobs = randomJobs(rng, 8, ['M1', 'M2']);
  const a = schedule(jobs, ['M1', 'M2']);
  const b = schedule(jobs, ['M1', 'M2']);
  assert.deepEqual(a, b);
});

test('scales to 20 jobs on two devices', () => {
  const rng = mulberry32(99);
  const jobs = [];
  for (let i = 0; i < 20; i += 1) {
    const release = Math.floor(rng() * 30);
    jobs.push({
      id: `J${String(i + 1).padStart(2, '0')}`,
      release,
      due: release + 8 + Math.floor(rng() * 20),
      duration: 1 + Math.floor(rng() * 3),
    });
  }
  const result = schedule(jobs, ['M1', 'M2']);
  assert.equal(result.entries.length, 20);
  assert.equal(result.certificate.tieRank, null); // enumeration skipped above limit
  assert.equal(typeof result.objective, 'number');
  // verify schedule is internally consistent: no overlap per device, releases respected
  for (const device of ['M1', 'M2']) {
    const entries = result.entries.filter((e) => e.deviceId === device);
    let prevEnd = 0;
    for (const e of entries) {
      const job = jobs.find((j) => j.id === e.jobId);
      assert.ok(e.start >= job.release);
      assert.ok(e.start >= prevEnd);
      assert.equal(e.end, e.start + job.duration);
      prevEnd = e.end;
    }
  }
});
