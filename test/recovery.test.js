import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Archive, CrashError } from '../src/archive.js';
import { recover } from '../src/recover.js';
import { iso, freshDir } from './helpers.js';

const SEED = [
  { site: 'S1', time: iso(0), value: 10 },
  { site: 'S1', time: iso(1), value: 20 },
];
const VICTIM = [{ site: 'S1', time: iso(2), value: 30 }];

async function seeded() {
  const dir = await freshDir();
  const a = await Archive.open(dir);
  await a.ingest(SEED, { batchId: 'seed' });
  return { dir, a };
}

// Acceptance 4: crash at each defined fault point, then recover and verify
// the certificate. The three points are the three write stages of a commit.

test('fault point 1 — crash before fsync: uncommitted event is lost cleanly', async () => {
  const { dir } = await seeded();
  const crashing = await Archive.open(dir, { fault: { point: 'beforeFsync' } });
  await assert.rejects(() => crashing.ingest(VICTIM, { batchId: 'victim' }), CrashError);

  const report = await recover(dir);
  assert.equal(report.action, 'verify-only'); // nothing durable changed
  assert.equal(report.seq, 2); // still at the seed commit

  const a = await Archive.open(dir);
  const q = a.query('S1', iso(0), iso(2));
  assert.equal(q.mean, 15); // victim event never happened
  assert.equal(q.usedCount, 2);
  assert.equal((await a.verify()).ok, true); // certificate still verifies
});

test('fault point 2 — crash after index update: recovery rolls forward from the log', async () => {
  const { dir } = await seeded();
  const crashing = await Archive.open(dir, { fault: { point: 'afterIndex' } });
  await assert.rejects(() => crashing.ingest(VICTIM, { batchId: 'victim' }), CrashError);

  // durable state at the crash: log+index hold seq 3, manifest still says 2
  const report = await recover(dir);
  assert.equal(report.action, 'rolled-forward');
  assert.equal(report.seq, 3);

  const a = await Archive.open(dir);
  const q = a.query('S1', iso(0), iso(2));
  assert.equal(q.mean, 20); // (10+20+30)/3 — victim event survived
  assert.equal(q.usedCount, 3);
  assert.equal((await a.verify()).ok, true); // certificate re-issued and verifies
});

test('fault point 3 — crash after manifest write: fully committed, verify-only', async () => {
  const { dir } = await seeded();
  const crashing = await Archive.open(dir, { fault: { point: 'afterManifest' } });
  await assert.rejects(() => crashing.ingest(VICTIM, { batchId: 'victim' }), CrashError);

  const report = await recover(dir);
  assert.equal(report.action, 'verify-only'); // all three artifacts already agree
  assert.equal(report.seq, 3);

  const a = await Archive.open(dir);
  assert.equal(a.query('S1', iso(0), iso(2)).mean, 20);
  assert.equal((await a.verify()).ok, true);
});

test('torn tail: garbage after the last valid event is truncated', async () => {
  const { dir } = await seeded();
  await appendFile(join(dir, 'events.log'), '{"seq":3,"lamport":3,"type":"inges'); // torn line

  const report = await recover(dir);
  assert.equal(report.torn, true);
  assert.ok(report.droppedBytes > 0);
  assert.equal(report.seq, 2);

  const a = await Archive.open(dir);
  assert.equal(a.query('S1', iso(0), iso(2)).mean, 15);
  assert.equal((await a.verify()).ok, true);

  // archive keeps working after the truncation
  await a.ingest(VICTIM, { batchId: 'after-torn' });
  assert.equal(a.query('S1', iso(0), iso(2)).mean, 20);
  assert.equal((await a.verify()).ok, true);
});

test('recovery is idempotent and survives reopen across commits', async () => {
  const { dir } = await seeded();
  const r1 = await recover(dir);
  const r2 = await recover(dir);
  assert.deepEqual(r1, r2);

  // undo survives a reopen (state rebuilt from the log, not just the index)
  const a = await Archive.open(dir);
  await a.correct({
    batchId: 'fix',
    corrections: [{ site: 'S1', time: iso(0), op: 'replace', value: 999 }],
  });
  await a.undo('fix');
  const reopened = await Archive.open(dir);
  assert.equal(reopened.audit(`S1@${iso(0)}`).current.value, 10);
  assert.equal((await reopened.verify()).ok, true);
});
