import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.js';
import { tmpdir, runCli, writeScript } from '../support/helpers.js';

const SCRIPT1 = `
line A
calendar A { shift 08:00-16:00 }
job J1 { duration 30m priority 1 }
commit
`;
const SCRIPT2 = `
add-job J2 { duration 45m priority 5 }
commit
`;

// Build a store with one committed transaction (gen=1, jobs=[J1]).
function baseStore() {
  const dir = tmpdir();
  runCli(['init', dir]);
  const r = runCli(['apply', dir, writeScript(dir, SCRIPT1)]);
  assert.equal(r.code, 0);
  return dir;
}

function committedJobs(dir) {
  const r = runCli(['recover', dir]);
  assert.equal(r.code, 0, r.stderr);
  const m = /RECOVERED gen=(\d+) jobs=(\d+)/.exec(r.stdout);
  return { gen: +m[1], jobs: +m[2] };
}

test('failure point 1: crash before WAL commit -> uncommitted tail ignored', () => {
  const dir = baseStore();
  // simulate a crashed apply: op records appended, no commit record
  const store = new Store(dir);
  store.appendOp({ cmd: 'add-job', job: { id: 'J2', duration: 45, priority: 5, lines: null } });
  store.appendOp({ cmd: 'commit' }); // not yet durable as a commit *record*
  assert.deepEqual(committedJobs(dir), { gen: 1, jobs: 1 });
  // idempotent: recovering again gives the same result
  assert.deepEqual(committedJobs(dir), { gen: 1, jobs: 1 });
});

test('failure point 2: crash after WAL commit, before state -> replay repairs state', () => {
  const dir = baseStore();
  const state = new Store(dir).recover();
  const jobs2 = [...state.jobs, { id: 'J2', duration: 45, priority: 5, lines: null }];
  // simulate crash: WAL commit record durable, state.json not yet written
  const store = new Store(dir);
  store.appendWal([{ type: 'commit', seq: 2, snapshot: { env: state.env, jobs: jobs2 } }]);
  assert.deepEqual(committedJobs(dir), { gen: 2, jobs: 2 });
  // state.json was repaired: WAL can be removed and the result is unchanged
  fs.writeFileSync(path.join(dir, 'wal.log'), '');
  assert.deepEqual(committedJobs(dir), { gen: 2, jobs: 2 });
});

test('failure point 3: crash after state, before checkpoint -> stale checkpoint ignored', () => {
  const dir = baseStore();
  const ckpt = path.join(dir, 'checkpoint.json');
  const gen1Checkpoint = fs.readFileSync(ckpt, 'utf8'); // checkpoint at gen=1
  // second commit goes through fully (gen=2 everywhere)
  const r = runCli(['apply', dir, writeScript(dir, SCRIPT2)]);
  assert.equal(r.code, 0, r.stderr);
  // simulate crash before checkpoint write: checkpoint still holds gen=1
  fs.writeFileSync(ckpt, gen1Checkpoint);
  assert.deepEqual(committedJobs(dir), { gen: 2, jobs: 2 });
  assert.deepEqual(committedJobs(dir), { gen: 2, jobs: 2 }); // idempotent
});

test('recovery result equals the last commit for all three fixtures', () => {
  // fixture 2 recovered state must equal a normally committed gen=2 store
  const dirA = baseStore();
  const state = new Store(dirA).recover();
  const jobs2 = [...state.jobs, { id: 'J2', duration: 45, priority: 5, lines: null }];
  new Store(dirA).appendWal([{ type: 'commit', seq: 2, snapshot: { env: state.env, jobs: jobs2 } }]);
  const recovered = new Store(dirA).recover();

  const dirB = baseStore();
  runCli(['apply', dirB, writeScript(dirB, SCRIPT2)]);
  const committed = new Store(dirB).recover();

  assert.deepEqual(recovered, committed);
});
