import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { schedule } from '../src/scheduler.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sched-store-'));
}

const JOBS_A = [
  { id: 'A', release: 0, due: 10, duration: 2 },
  { id: 'B', release: 1, due: 6, duration: 3 },
];
const JOBS_B = [
  { id: 'A', release: 0, due: 10, duration: 2 },
  { id: 'B', release: 1, due: 6, duration: 3 },
  { id: 'C', release: 0, due: 8, duration: 1 },
];

function planFrom(tx) {
  const result = schedule(tx.jobs, tx.devices);
  return {
    objective: result.objective,
    entries: result.entries,
    certificate: result.certificate,
    baseVersion: tx.jobsVersion,
  };
}

test('staged plan commits and survives reopen (WAL replay)', () => {
  const dir = tmpdir();
  let store = Store.open(dir);
  store.setJobs(JOBS_A);
  const tx = store.begin();
  store.stage(tx, planFrom(tx));
  store.commit(tx);
  assert.equal(store.planVersion, 1);
  store.close();

  store = Store.open(dir);
  const state = store.getState();
  assert.equal(state.planVersion, 1);
  assert.equal(state.jobsVersion, 1);
  assert.equal(state.plan.entries.length, 2);
  assert.equal(state.plan.baseVersion, 1);
  store.close();
});

test('concurrent jobs update invalidates staged plan with E_SNAPSHOT', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  store.setJobs(JOBS_A); // jobsVersion 1
  const tx = store.begin(); // reads jobsVersion 1
  const plan = planFrom(tx);
  store.setJobs(JOBS_B); // concurrent modification -> jobsVersion 2
  store.stage(tx, plan);
  assert.throws(() => store.commit(tx), (err) => {
    assert.equal(err.code, 'E_SNAPSHOT');
    assert.equal(err.expected, 1);
    assert.equal(err.actual, 2);
    return true;
  });
  // old state untouched, no plan committed
  assert.equal(store.planVersion, 0);
  assert.equal(store.getState().plan, null);
  // retry on the fresh version succeeds
  const tx2 = store.begin();
  store.stage(tx2, planFrom(tx2));
  store.commit(tx2);
  assert.equal(store.planVersion, 1);
  assert.equal(store.getState().plan.entries.length, 3);
  store.close();
});

test('replan with stale base version returns E_SNAPSHOT', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  store.setJobs(JOBS_A);
  const tx1 = store.begin();
  store.stage(tx1, planFrom(tx1));
  store.commit(tx1);
  store.setJobs(JOBS_B);
  // attempting to stage+commit a plan computed from the old job set must fail
  const stalePlan = {
    objective: 0,
    entries: [],
    certificate: null,
    baseVersion: 1,
  };
  const txStale = { ...store.begin(), jobsVersion: 1 };
  store.stage(txStale, stalePlan);
  assert.throws(() => store.commit(txStale), (err) => err.code === 'E_SNAPSHOT');
  store.close();
});

test('uncommitted staged plan is discarded after simulated crash', () => {
  const dir = tmpdir();
  let store = Store.open(dir);
  store.setJobs(JOBS_A);
  const tx1 = store.begin();
  store.stage(tx1, planFrom(tx1));
  store.commit(tx1); // plan v1 visible
  store.setJobs(JOBS_B);
  const tx2 = store.begin();
  store.stage(tx2, planFrom(tx2)); // staged but never committed -> "crash"
  store.close(); // close fd without commit marker

  store = Store.open(dir); // recovery replays WAL
  const state = store.getState();
  assert.equal(state.planVersion, 1, 'old plan version retained');
  assert.equal(state.plan.entries.length, 2, 'old plan (JOBS_A) still visible');
  assert.equal(state.jobsVersion, 2, 'jobs update was committed and survives');
  store.close();
});

test('E_INFEASIBLE does not overwrite the previous plan', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  store.setJobs(JOBS_A);
  const tx = store.begin();
  store.stage(tx, planFrom(tx));
  store.commit(tx);
  const before = store.getState();

  store.setJobs([{ id: 'X', release: 0, due: 1, duration: 1, devices: [] }]);
  const tx2 = store.begin();
  assert.throws(() => schedule(tx2.jobs, tx2.devices), (err) => {
    assert.equal(err.code, 'E_INFEASIBLE');
    assert.equal(err.jobId, 'X');
    return true;
  });
  const after = store.getState();
  assert.deepEqual(after.plan, before.plan, 'previous plan intact');
  assert.equal(after.planVersion, before.planVersion);
  assert.equal(after.version, before.version + 1, 'only the jobs commit advanced the version');
  store.close();
});

test('(jobId, deviceId) secondary index reflects the committed plan', () => {
  const dir = tmpdir();
  let store = Store.open(dir);
  store.setJobs(JOBS_A);
  const tx = store.begin();
  const plan = planFrom(tx);
  store.stage(tx, plan);
  store.commit(tx);
  store.close();

  store = Store.open(dir); // index rebuilt from WAL on recovery
  for (const entry of plan.entries) {
    const hit = store.lookup(entry.jobId, entry.deviceId);
    assert.ok(hit, `index hit for ${entry.jobId}/${entry.deviceId}`);
    assert.equal(hit.start, entry.start);
    assert.equal(hit.end, entry.end);
    assert.equal(hit.planVersion, 1);
  }
  const first = plan.entries[0];
  const otherDevice = first.deviceId === 'M1' ? 'M2' : 'M1';
  assert.equal(store.lookup(first.jobId, otherDevice), null);
  assert.equal(store.lookup('NOPE', 'M1'), null);
  store.close();
});

test('torn trailing WAL line is ignored on recovery', () => {
  const dir = tmpdir();
  let store = Store.open(dir);
  store.setJobs(JOBS_A);
  const tx = store.begin();
  store.stage(tx, planFrom(tx));
  store.commit(tx);
  store.close();
  fs.appendFileSync(path.join(dir, 'wal.log'), '{"type":"plan_comm'); // torn tail
  store = Store.open(dir);
  assert.equal(store.getState().planVersion, 1);
  store.close();
});
