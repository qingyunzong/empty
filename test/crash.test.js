// Acceptance 2: crash at each of the three injection points
// (after-tmp-write / before-rename / after-rename) recovers with no double
// ownership and a well-defined owner.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, Scheduler, CrashInjected, CRASH_POINTS } from '../src/persist.js';
import { audit } from '../src/audit.js';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agv-crash-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const CLAIM_A = { type: 'claim', task: 'T1', agv: 'A', epoch: 1, ttl: 100, ts: 0, clock: { A: 1 } };

function activeLeaseFiles(dir) {
  const store = Store.init(dir);
  const out = [];
  for (const name of fs.readdirSync(store.leasesDir)) {
    if (!name.endsWith('.json')) continue;
    const rec = store.readLeaseFile(decodeURIComponent(name.slice(0, -5)));
    if (rec.status === 'active') out.push(rec);
  }
  return out;
}

test('acceptance 2: all three crash points recover without double ownership', (t) => {
  for (const point of CRASH_POINTS) {
    const dir = tmpDir(t);
    const scheduler = Scheduler.open(dir);
    scheduler.applyEvent({ type: 'join', agv: 'A', ts: 0 });
    assert.throws(() => scheduler.applyEvent(CLAIM_A, { crashPoint: point }), CrashInjected);

    // Simulated restart: recover, then inspect.
    const store = Store.init(dir);
    const report = store.recover();
    const recovered = store.load();
    const summary = recovered.summary();

    if (point === 'after-rename') {
      assert.ok(
        report.some((r) => r.op === 'adopt-lease' && r.holder === 'A'),
        'committed lease is adopted into the journal',
      );
      assert.equal(summary.tasks.T1.holder, 'A', 'renamed lease is authoritative');
      assert.equal(summary.tasks.T1.leaseStatus, 'active');
    } else {
      assert.ok(report.some((r) => r.op === 'discard-tmp'), 'orphan tmp is discarded');
      assert.equal(summary.tasks.T1, undefined, 'grant never committed; task unknown');
      assert.equal(activeLeaseFiles(dir).length, 0, 'no active lease on disk');
    }

    // Exactly one active lease record may exist for the task.
    const active = activeLeaseFiles(dir).filter((r) => r.task === 'T1');
    assert.ok(active.length <= 1, 'no double ownership after recovery');
    assert.equal(audit(dir).ok, true, `audit clean after crash at ${point}`);

    // Recovery is idempotent.
    const second = Store.init(dir).recover();
    assert.ok(!second.some((r) => r.op === 'adopt-lease' || r.op === 'discard-tmp'));
  }
});

test('acceptance 2b: crash during takeover never leaves two owners', (t) => {
  for (const point of CRASH_POINTS) {
    const dir = tmpDir(t);
    const scheduler = Scheduler.open(dir);
    scheduler.applyEvent({ type: 'join', agv: 'A', ts: 0 });
    scheduler.applyEvent({ type: 'join', agv: 'B', ts: 0 });
    scheduler.applyEvent(CLAIM_A); // committed grant to A, expiry 100

    const takeover = { type: 'claim', task: 'T1', agv: 'B', epoch: 2, ttl: 100, ts: 100, clock: { A: 1, B: 1 } };
    assert.throws(() => scheduler.applyEvent(takeover, { crashPoint: point }), CrashInjected);

    const store = Store.init(dir);
    store.recover();
    const summary = store.load().summary();
    const holder = summary.tasks.T1.holder;
    if (point === 'after-rename') assert.equal(holder, 'B', 'takeover committed by rename');
    else assert.equal(holder, 'A', 'takeover never committed; old lease stands');

    const active = activeLeaseFiles(dir).filter((r) => r.task === 'T1');
    assert.equal(active.length, 1, 'exactly one active lease');
    assert.equal(active[0].holder, holder);
    assert.equal(audit(dir).ok, true);
  }
});

test('recovery is followed by normal operation (no zombie state)', (t) => {
  const dir = tmpDir(t);
  const scheduler = Scheduler.open(dir);
  scheduler.applyEvent({ type: 'join', agv: 'A', ts: 0 });
  assert.throws(() => scheduler.applyEvent(CLAIM_A, { crashPoint: 'after-tmp-write' }), CrashInjected);

  const recovered = Scheduler.open(dir);
  const res = recovered.applyEvent(CLAIM_A); // retry after recovery
  assert.equal(res.decision, 'granted');
  assert.equal(recovered.summary().tasks.T1.holder, 'A');
  assert.equal(audit(dir).ok, true);
});
