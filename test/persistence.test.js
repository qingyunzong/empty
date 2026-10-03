// Persistence validation failures must raise PersistenceError (exit code 9).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, Scheduler, PersistenceError, EXIT } from '../src/persist.js';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agv-persist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function committedScheduler(dir) {
  const scheduler = Scheduler.open(dir);
  scheduler.applyEvent({ type: 'join', agv: 'A', ts: 0 });
  scheduler.applyEvent({ type: 'claim', task: 'T1', agv: 'A', epoch: 1, ttl: 100, ts: 0, clock: { A: 1 } });
  return scheduler;
}

test('checksum mismatch in a committed lease fails validation', (t) => {
  const dir = tmpDir(t);
  committedScheduler(dir);
  const store = Store.init(dir);
  const file = store.leaseFile('T1');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  rec.epoch = 99; // tamper without fixing the checksum
  fs.writeFileSync(file, `${JSON.stringify(rec)}\n`);
  assert.throws(() => Store.init(dir).recover(), (err) => {
    assert.ok(err instanceof PersistenceError);
    assert.equal(err.exitCode, EXIT.PERSIST);
    assert.match(err.message, /checksum/);
    return true;
  });
});

test('corrupt journal JSON fails validation', (t) => {
  const dir = tmpDir(t);
  committedScheduler(dir);
  const store = Store.init(dir);
  fs.appendFileSync(store.journalPath, '{not json\n');
  assert.throws(() => Store.init(dir).recover(), PersistenceError);
});

test('journal seq gap fails validation', (t) => {
  const dir = tmpDir(t);
  committedScheduler(dir);
  const store = Store.init(dir);
  const lines = fs.readFileSync(store.journalPath, 'utf8').trim().split('\n');
  const last = JSON.parse(lines.at(-1));
  last.seq = 42;
  lines[lines.length - 1] = JSON.stringify(last);
  fs.writeFileSync(store.journalPath, `${lines.join('\n')}\n`);
  assert.throws(() => Store.init(dir).recover(), /seq mismatch/);
});

test('fencing epoch regression inside the journal fails validation', (t) => {
  const dir = tmpDir(t);
  const store = Store.init(dir);
  const grant = (seq, tseq, epoch) => JSON.stringify({
    seq,
    tseq,
    ev: { type: 'claim', task: 'T1', agv: 'A', epoch, ts: 0 },
    lease: { task: 'T1', holder: 'A', epoch, expiry: 100, status: 'active', clock: {}, tseq, ts: 0 },
  });
  fs.writeFileSync(store.journalPath, `${grant(1, 1, 5)}\n${grant(2, 2, 3)}\n`);
  assert.throws(() => Store.init(dir).recover(), /epoch regression/);
});

test('garbage tmp file is discarded without failing validation', (t) => {
  const dir = tmpDir(t);
  committedScheduler(dir);
  const store = Store.init(dir);
  fs.writeFileSync(`${store.leaseFile('T2')}.tmp`, 'garbage{{{');
  const report = Store.init(dir).recover();
  assert.ok(report.some((r) => r.op === 'discard-tmp'));
  assert.ok(report.at(-1).ok);
});

test('missing lease file is regenerated from the journal', (t) => {
  const dir = tmpDir(t);
  committedScheduler(dir);
  const store = Store.init(dir);
  fs.rmSync(store.leaseFile('T1'));
  const report = Store.init(dir).recover();
  assert.ok(report.some((r) => r.op === 'restore-lease' && r.task === 'T1'));
  const rec = Store.init(dir).readLeaseFile('T1');
  assert.equal(rec.holder, 'A');
  assert.equal(rec.status, 'active');
});

test('schema violation in a lease file fails validation', (t) => {
  const dir = tmpDir(t);
  committedScheduler(dir);
  const store = Store.init(dir);
  fs.writeFileSync(store.leaseFile('T1'), `${JSON.stringify({ task: 'T1', holder: 'A' })}\n`);
  assert.throws(() => Store.init(dir).recover(), PersistenceError);
});
