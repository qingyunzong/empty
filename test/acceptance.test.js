import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EXAMPLE_JE, EXAMPLE_EVENTS, tmpdir, runJe, readJson } from './helpers.js';

const CRASH_ENV = { JE_CRASH_MODE: 'throw' };

test('acceptance 1: three normal batches commit with correct balances', () => {
  const db = tmpdir();
  const r = runJe(['run', EXAMPLE_JE, EXAMPLE_EVENTS, '--db', db]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /batch B1 committed/);
  assert.match(r.stdout, /batch B2 committed/);
  assert.match(r.stdout, /batch B3 committed/);

  const index = readJson(path.join(db, 'index.json'));
  assert.deepEqual(index.balances['2025-01'], { cash: 240, ar: -40, revenue: -190, fees: -10 });
  assert.deepEqual(index.balances['2025-02'], { cash: 30, supplies: -30 });
  for (const id of ['B1', 'B2', 'B3']) assert.equal(index.batches[id].status, 'COMMITTED');
});

test('acceptance 2: kill at the defined crash point, recover matches the no-crash reference', () => {
  const ref = tmpdir();
  const refRun = runJe(['run', EXAMPLE_JE, EXAMPLE_EVENTS, '--db', ref]);
  assert.equal(refRun.code, 0, refRun.stderr);
  const refBalances = readJson(path.join(ref, 'index.json')).balances;

  // 4 posts total (B1:2, B2:1, B3:1). Kill after the 4th POST hits disk,
  // before its index update -> the defined crash point.
  const db = tmpdir();
  const crashed = runJe(['run', EXAMPLE_JE, EXAMPLE_EVENTS, '--db', db],
    { env: { ...CRASH_ENV, JE_CRASH_AFTER_POST: '4' } });
  assert.ok(crashed.crash, 'expected a simulated crash');

  // The post is durable but not indexed yet.
  const dirtyIndex = readJson(path.join(db, 'index.json'));
  assert.equal(dirtyIndex.posts['B3:0'], undefined);
  assert.equal(dirtyIndex.dirty, true);
  const postsOnDisk = fs.readFileSync(path.join(db, 'posts.jsonl'), 'utf8').trim().split('\n');
  assert.equal(postsOnDisk.length, 4);

  // Re-running without recovery is refused with E_CRASH.
  const rerun = runJe(['run', EXAMPLE_JE, EXAMPLE_EVENTS, '--db', db]);
  assert.equal(rerun.code, 1);
  assert.match(rerun.stderr, /E_CRASH/);

  const rec = runJe(['recover', '--db', db]);
  assert.equal(rec.code, 0, rec.stderr);
  assert.match(rec.stdout, /replayed 1 action/);
  assert.match(rec.stdout, /IN_FLIGHT batches \(pending, NOT failed\): B3/);

  // No double-posting, no omission: balances identical to the reference.
  const recovered = readJson(path.join(db, 'index.json'));
  assert.deepEqual(recovered.balances, refBalances);
  assert.equal(Object.keys(recovered.posts).length, 4);
  assert.equal(recovered.batches.B3.status, 'IN_FLIGHT'); // pending, not failed
  assert.equal(recovered.batches.B1.status, 'COMMITTED');
  assert.equal(recovered.dirty, false);
});

test('acceptance 2b: crash between WAL write and post write is replayed too', () => {
  const db = tmpdir();
  const crashed = runJe(['run', EXAMPLE_JE, EXAMPLE_EVENTS, '--db', db],
    { env: { ...CRASH_ENV, JE_CRASH_AFTER_WAL: '3' } });
  assert.ok(crashed.crash, 'expected a simulated crash');
  const postsOnDisk = fs.readFileSync(path.join(db, 'posts.jsonl'), 'utf8').trim().split('\n');
  assert.equal(postsOnDisk.length, 2); // 3rd post only exists in the WAL

  const rec = runJe(['recover', '--db', db]);
  assert.equal(rec.code, 0, rec.stderr);
  const postsAfter = fs.readFileSync(path.join(db, 'posts.jsonl'), 'utf8').trim().split('\n');
  assert.equal(postsAfter.length, 3);
  const index = readJson(path.join(db, 'index.json'));
  assert.equal(index.posts['B2:0'], true);
  assert.equal(index.balances['2025-01'].cash, 240);
});

test('acceptance 3: repeated recover is idempotent', () => {
  const db = tmpdir();
  runJe(['run', EXAMPLE_JE, EXAMPLE_EVENTS, '--db', db],
    { env: { ...CRASH_ENV, JE_CRASH_AFTER_POST: '4' } });

  const first = runJe(['recover', '--db', db]);
  assert.equal(first.code, 0, first.stderr);
  const snapshot = fs.readFileSync(path.join(db, 'index.json'), 'utf8');
  const postsSnapshot = fs.readFileSync(path.join(db, 'posts.jsonl'), 'utf8');

  const second = runJe(['recover', '--db', db]);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /replayed 0 action/);
  assert.equal(fs.readFileSync(path.join(db, 'index.json'), 'utf8'), snapshot);
  assert.equal(fs.readFileSync(path.join(db, 'posts.jsonl'), 'utf8'), postsSnapshot);

  const third = runJe(['recover', '--db', db]);
  assert.equal(third.code, 0, third.stderr);
  assert.equal(fs.readFileSync(path.join(db, 'index.json'), 'utf8'), snapshot);
});

test('acceptance 4: posting into a closed period fails with E_PERIOD', () => {
  const db = tmpdir();
  const ok = runJe(['run', EXAMPLE_JE, EXAMPLE_EVENTS, '--db', db]);
  assert.equal(ok.code, 0, ok.stderr);

  const close = runJe(['close-period', '2025-01', '--db', db]);
  assert.equal(close.code, 0, close.stderr);

  const again = runJe(['run', EXAMPLE_JE, EXAMPLE_EVENTS, '--db', db]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /E_PERIOD/);
  assert.match(again.stderr, /2025-01.*closed/);
});

test('E_REPLAY: corrupt WAL record aborts recovery', () => {
  const db = tmpdir();
  runJe(['run', EXAMPLE_JE, EXAMPLE_EVENTS, '--db', db],
    { env: { ...CRASH_ENV, JE_CRASH_AFTER_POST: '4' } });
  fs.appendFileSync(path.join(db, 'wal.log'), '{not json\n');
  const rec = runJe(['recover', '--db', db]);
  assert.equal(rec.code, 1);
  assert.match(rec.stderr, /E_REPLAY/);
});

test('E_REPLAY: post content mismatch between WAL and disk aborts recovery', () => {
  const db = tmpdir();
  runJe(['run', EXAMPLE_JE, EXAMPLE_EVENTS, '--db', db],
    { env: { ...CRASH_ENV, JE_CRASH_AFTER_POST: '4' } });
  const postsPath = path.join(db, 'posts.jsonl');
  const posts = fs.readFileSync(postsPath, 'utf8').trim().split('\n').map(JSON.parse);
  posts[3].lines[0].amount = 999999; // tamper with the durable post
  fs.writeFileSync(postsPath, posts.map((p) => JSON.stringify(p)).join('\n') + '\n');
  const rec = runJe(['recover', '--db', db]);
  assert.equal(rec.code, 1);
  assert.match(rec.stderr, /E_REPLAY/);
});
