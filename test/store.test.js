'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const { solve } = require('../src/scheduler');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sched-store-'));
}

const JOBS_A = {
  jobs: [
    { id: 'J1', release: 0, due: 6, duration: 3 },
    { id: 'J2', release: 1, due: 5, duration: 2 },
  ],
};
const JOBS_B = {
  jobs: [
    { id: 'K1', release: 0, due: 4, duration: 2 },
    { id: 'K2', release: 0, due: 9, duration: 3 },
  ],
};

function crashAt(point) {
  return (p) => {
    if (p === point) throw new Error(`simulated crash at ${p}`);
  };
}

test('commit makes a new plan version visible and indexed', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  store.setJobs(JOBS_A);
  const { version, plan } = store.planAndCommit();
  assert.equal(version, 1);
  assert.equal(store.current().version, 1);
  assert.equal(plan.jobsVersion, 1);
  // Secondary index on (jobId, deviceId).
  for (const a of plan.assignments) {
    const entry = store.lookup(a.jobId, a.deviceId);
    assert.ok(entry, `missing index entry for ${a.jobId}/${a.deviceId}`);
    assert.equal(entry.version, 1);
  }
  const other = plan.assignments[0].deviceId === 'M1' ? 'M2' : 'M1';
  assert.equal(store.lookup(plan.assignments[0].jobId, other), null);
  // Survives reopen.
  const reopened = Store.open(dir);
  assert.equal(reopened.current().version, 1);
  assert.deepEqual(reopened.current().plan, store.current().plan);
});

test('acceptance 2: commit after concurrent job change fails with E_SNAPSHOT', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  store.setJobs(JOBS_A);
  store.planAndCommit();

  // A planning transaction reads jobsVersion 1...
  const tx = store.beginPlan();
  const stagedPlan = { jobsVersion: tx.baseJobsVersion, ...solve({ jobs: store.jobs, devices: store.devices }) };
  store.stage(tx, stagedPlan);
  // ...then the job set is modified concurrently...
  store.setJobs(JOBS_B);
  // ...and both the original commit and a replay of it are rejected.
  assert.throws(() => store.commit(tx), (e) => e.code === 'E_SNAPSHOT' && e.details.baseJobsVersion === 1 && e.details.currentJobsVersion === 2);
  assert.throws(() => store.commit(tx), (e) => e.code === 'E_SNAPSHOT');

  // Replanning from the old snapshot is rejected as well.
  const staleTx = { txId: 'tx-replayed', baseJobsVersion: 1, baseJobsHash: tx.baseJobsHash, staged: stagedPlan };
  store.stage(staleTx, stagedPlan);
  assert.throws(() => store.commit(staleTx), (e) => e.code === 'E_SNAPSHOT');

  // The stale staged plans were never committed: still version 1 visible.
  const reopened = Store.open(dir);
  assert.equal(reopened.current().version, 1);
  assert.equal(reopened.jobsVersion, 2);
  // A fresh transaction on the latest jobs commits fine.
  const { version } = reopened.planAndCommit();
  assert.equal(version, 2);
});

test('acceptance 3a: crash after_stage discards the staged plan, keeps the old one', () => {
  const dir = tmpdir();
  let store = Store.open(dir);
  store.setJobs(JOBS_A);
  store.planAndCommit();
  store.setJobs(JOBS_B);

  store = Store.open(dir, { crashHook: crashAt('after_stage') });
  assert.throws(() => store.planAndCommit(), /after_stage/);

  const recovered = Store.open(dir);
  assert.equal(recovered.current().version, 1, 'old plan must remain visible');
  assert.equal(recovered.current().plan.jobsVersion, 1);
  assert.equal(recovered.jobsVersion, 2, 'job update itself is durable');
  assert.ok(!fs.existsSync(path.join(dir, 'versions', 'v-2.json')));
});

test('acceptance 3b: crash after_commit makes the new plan fully visible', () => {
  const dir = tmpdir();
  let store = Store.open(dir);
  store.setJobs(JOBS_A);
  store.planAndCommit();
  store.setJobs(JOBS_B);

  store = Store.open(dir, { crashHook: crashAt('after_commit') });
  assert.throws(() => store.planAndCommit(), /after_commit/);

  const recovered = Store.open(dir);
  assert.equal(recovered.current().version, 2, 'committed version must become visible');
  assert.equal(recovered.current().plan.jobsVersion, 2);
  const plan = recovered.current().plan;
  assert.ok(plan.certificate && typeof plan.certificate.inputHash === 'string');
  assert.ok(Object.keys(plan.schedule).length === 2);
  for (const a of plan.assignments) assert.ok(recovered.lookup(a.jobId, a.deviceId));
  // Recovery is idempotent.
  const again = Store.open(dir);
  assert.deepEqual(again.current(), recovered.current());
});

test('acceptance 3c: infeasible replan does not overwrite the old plan', () => {
  const dir = tmpdir();
  let store = Store.open(dir);
  store.setJobs(JOBS_A);
  store.planAndCommit();
  const before = store.current();

  store.setJobs({
    jobs: [
      { id: 'A', release: 0, due: 10, duration: 3 },
      { id: 'B', release: 0, due: 10, duration: 3 },
    ],
    devices: [{ id: 'M1', capacity: 4 }, { id: 'M2', capacity: 1 }],
  });
  assert.throws(
    () => store.planAndCommit(),
    (e) => e.code === 'E_INFEASIBLE' && e.details.jobId === 'A'
  );
  assert.deepEqual(store.current(), before, 'error state must not overwrite the old plan');

  const recovered = Store.open(dir);
  assert.equal(recovered.current().version, 1);
  assert.deepEqual(recovered.current().plan, before.plan);
});

test('torn WAL tail is ignored during recovery', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  store.setJobs(JOBS_A);
  store.planAndCommit();
  fs.appendFileSync(path.join(dir, 'wal.log'), '{"op":"commit","txId":"tx-garbage"');
  const recovered = Store.open(dir);
  assert.equal(recovered.current().version, 1);
});
