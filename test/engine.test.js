import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RepairEngine, serializeSnapshot } from '../src/engine.js';
import { Journal } from '../src/journal.js';

const entry = (id, over = {}) => ({
  id,
  account: 'acct-1',
  day: '2026-10-03',
  merchant: 'm-1',
  amount: 100,
  currency: 'USD',
  ...over,
});

test('reconcile repairs up to `slots` tasks per pass; the rest stay pending', () => {
  const engine = new RepairEngine({
    ledger: [entry('a'), entry('b', { amount: 200 }), entry('c', { amount: 300 })],
    snapshot: [entry('a', { amount: 999 })], // a: mismatch, b/c: missing_in_snapshot
    slots: 2,
  });
  const r1 = engine.reconcile();
  assert.equal(r1.repaired.length, 2);
  assert.equal(r1.pending.length, 1);
  assert.deepEqual(r1.conflicts, []);
  assert.match(r1.auditRoot, /^[0-9a-f]{64}$/);
  // mismatch (severity 3) is repaired before inserts (severity 2)
  assert.equal(r1.repaired[0], 'repair:mismatch:a');
  const r2 = engine.reconcile();
  assert.equal(r2.repaired.length, 1);
  assert.equal(r2.pending.length, 0);
  // snapshot now equals ledger
  assert.deepEqual(
    serializeSnapshot(engine.entries),
    serializeSnapshot(engine.ledger),
  );
});

test('undo restores the snapshot byte-for-byte', () => {
  const snapshot = [entry('a'), entry('b')];
  const engine = new RepairEngine({ ledger: [entry('a'), entry('b'), entry('c')], snapshot, slots: 4 });
  const before = engine.snapshotBytes();
  const r = engine.reconcile();
  assert.deepEqual(r.repaired, ['repair:missing_in_snapshot:c']);
  assert.notDeepEqual(engine.snapshotBytes(), before);
  engine.undo('repair:missing_in_snapshot:c');
  assert.deepEqual(engine.snapshotBytes(), before, 'snapshot bytes must be identical after undo');
});

test('undo of an unknown repair raises BAD_DIFF', () => {
  const engine = new RepairEngine({ ledger: [], snapshot: [] });
  assert.throws(() => engine.undo('nope'), (e) => e.code === 'BAD_DIFF');
});

test('sealed day rejects late ledger flow with SEALED conflict', () => {
  const engine = new RepairEngine({
    ledger: [entry('late-1', { late: true })],
    snapshot: [],
    slots: 1,
  });
  engine.seal('acct-1', '2026-10-03');
  const r = engine.reconcile();
  assert.deepEqual(r.repaired, []);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].code, 'SEALED');
  assert.equal(r.conflicts[0].domain, 'acct-1@2026-10-03');
  assert.equal(engine.entries.length, 0, 'sealed day must not be rewritten');
});

test('supersedes chain rewrites a sealed day', () => {
  const ledger = [entry('a')];
  const engine = new RepairEngine({ ledger, snapshot: [], slots: 1 });
  const r1 = engine.reconcile();
  assert.deepEqual(r1.repaired, ['repair:missing_in_snapshot:a']);
  engine.seal('acct-1', '2026-10-03');
  const head = engine.history.headId('acct-1', '2026-10-03');
  // Late correction arrives for the sealed day, chained via supersedes.
  engine.ledger = [entry('a', { amount: 777, late: true, supersedes: head })];
  const r2 = engine.reconcile();
  assert.deepEqual(r2.conflicts, []);
  assert.deepEqual(r2.repaired, ['repair:mismatch:a']);
  assert.equal(engine.entries.find((e) => e.id === 'a').amount, 777);
  // Without the supersedes pointer the same correction is rejected.
  const engine2 = new RepairEngine({ ledger: [entry('a')], snapshot: [], slots: 1 });
  engine2.reconcile();
  engine2.seal('acct-1', '2026-10-03');
  engine2.ledger = [entry('a', { amount: 777, late: true })];
  const r3 = engine2.reconcile();
  assert.equal(r3.conflicts[0].code, 'SEALED');
  assert.equal(engine2.entries.find((e) => e.id === 'a').amount, 100);
});

test('concurrent repair from another source raises CONFLICT_DOMAIN', () => {
  const engine = new RepairEngine({ ledger: [entry('a')], snapshot: [], slots: 1 });
  engine.reconcile();
  // An out-of-band fix event from a different source, not chained.
  assert.throws(
    () =>
      engine.history.record({
        id: 'manual-1',
        account: 'acct-1',
        day: '2026-10-03',
        lamport: 99,
        source: 'manual-ops',
        seq: 1,
        kind: 'repair',
      }),
    (e) => e.code === 'CONFLICT_DOMAIN',
  );
});

test('auditRoot is deterministic for identical runs and changes on undo', () => {
  const build = () => {
    const e = new RepairEngine({ ledger: [entry('a'), entry('b')], snapshot: [], slots: 2 });
    e.reconcile();
    return e;
  };
  const e1 = build();
  const e2 = build();
  assert.equal(e1.audit.auditRoot, e2.audit.auditRoot);
  e1.undo('repair:missing_in_snapshot:b');
  assert.notEqual(e1.audit.auditRoot, e2.audit.auditRoot);
});

test('journal: plan without commit is discarded; committed plan replays idempotently', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-'));
  const journalPath = path.join(dir, 'journal.log');

  // Simulate a crash after PLAN but before COMMIT for task t2, and after
  // COMMIT for task t1, by driving the engine with a real journal.
  // Manually write a journal: committed plan for insert(a), orphan plan for insert(b).
  const j = new Journal(journalPath);
  const afterA = serializeSnapshot([entry('a')]).toString('utf8');
  j.plan('repair:missing_in_snapshot:a', { repair: { action: 'insert', entry: entry('a') }, domain: 'acct-1@2026-10-03', after: afterA });
  j.commit('repair:missing_in_snapshot:a');
  j.plan('repair:missing_in_snapshot:b', { repair: { action: 'insert', entry: entry('b') }, domain: 'acct-1@2026-10-03', after: serializeSnapshot([entry('a'), entry('b')]).toString('utf8') });
  // crash: no commit for b

  const recovered = new RepairEngine({ ledger: [], snapshot: [] });
  const bytes1 = recovered.recoverFromJournal(journalPath);
  assert.deepEqual(recovered.entries.map((e) => e.id), ['a'], 'orphan plan for b must be discarded');

  // Replay again: idempotent, no double apply, same bytes.
  const bytes2 = recovered.recoverFromJournal(journalPath);
  assert.deepEqual(bytes2, bytes1);
  const recovered2 = new RepairEngine({ ledger: [], snapshot: [] });
  assert.deepEqual(recovered2.recoverFromJournal(journalPath), bytes1);
});
