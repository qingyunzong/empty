import test from 'node:test';
import assert from 'node:assert/strict';
import { Archive } from '../src/archive.js';
import { iso, freshDir } from './helpers.js';

// Acceptance 2: undo touches only the target batch; when histories are
// concurrent (explicit Lamport values), "later" is decided by
// (lamport, site, seq) — not by arrival order.
test('undo affects only the target batch; lamport+site decides history order', async () => {
  const dir = await freshDir();
  const a = await Archive.open(dir);

  await a.ingest([{ site: 'S1', time: iso(0), value: 1 }], { batchId: 'base' }); // lamport 1
  // batch A arrives first but is logically LATER (lamport 10)
  await a.correct({
    batchId: 'A',
    corrections: [{ site: 'S1', time: iso(0), op: 'replace', value: 100, lamport: 10 }],
  });
  // batch B arrives second but is logically EARLIER (lamport 5)
  await a.correct({
    batchId: 'B',
    corrections: [{ site: 'S1', time: iso(0), op: 'replace', value: 50, lamport: 5 }],
  });
  // unrelated batch on another key — must never be touched by undoing A or B
  await a.correct({
    batchId: 'C',
    corrections: [{ site: 'S1', time: iso(1), op: 'replace', value: 777 }],
  });

  // logically latest wins regardless of arrival order
  assert.equal(a.audit(`S1@${iso(0)}`).current.value, 100);

  // undo A: rolls back to B (lamport 5), NOT to the ingested value —
  // the rollback boundary is defined in lamport order, not arrival order
  const r1 = await a.undo('A');
  assert.deepEqual(r1.affectedKeys, [`S1@${iso(0)}`]);
  assert.equal(a.audit(`S1@${iso(0)}`).current.value, 50);
  assert.equal(a.audit(`S1@${iso(1)}`).current.value, 777, 'batch C untouched');

  // undo B: only B remains masked; the original ingest version resurfaces
  await a.undo('B');
  assert.equal(a.audit(`S1@${iso(0)}`).current.value, 1);
  assert.equal(a.audit(`S1@${iso(1)}`).current.value, 777, 'batch C still untouched');
});

test('audit proves the rollback boundary with hashes', async () => {
  const dir = await freshDir();
  const a = await Archive.open(dir);
  await a.ingest([{ site: 'S1', time: iso(0), value: 1 }], { batchId: 'base' });
  await a.correct({
    batchId: 'bad-batch',
    corrections: [{ site: 'S1', time: iso(0), op: 'replace', value: 999, quality: 'suspect' }],
  });
  await a.undo('bad-batch');

  const audit = a.audit(`S1@${iso(0)}`);
  assert.equal(audit.current.value, 1); // restored to pre-batch version
  assert.equal(audit.history.length, 2); // nothing physically removed
  const masked = audit.history.find((h) => h.batchId === 'bad-batch');
  assert.equal(masked.undone, true);
  assert.equal(typeof masked.hash, 'string');

  assert.equal(audit.rollbackBoundaries.length, 1);
  const boundary = audit.rollbackBoundaries[0];
  assert.equal(boundary.batchId, 'bad-batch');
  assert.deepEqual(boundary.maskedSeqs, [masked.seq]);
  assert.deepEqual(boundary.maskedHashes, [masked.hash]);
  assert.equal(boundary.restoredVersion.value, 1);

  // boundary is anchored to the certificate head
  const verify = await a.verify();
  assert.equal(verify.ok, true);
  assert.equal(audit.certificate.head, verify.head);
});

test('concurrent sites at the same lamport: deterministic (lamport, site) order', async () => {
  const dir = await freshDir();
  const a = await Archive.open(dir);
  await a.ingest([
    { site: 'S1', time: iso(0), value: 1 },
    { site: 'S2', time: iso(0), value: 2 },
  ]);
  // two sites, identical lamport — merged concurrent histories
  await a.correct({
    batchId: 'm1',
    corrections: [
      { site: 'S2', time: iso(0), op: 'replace', value: 22, lamport: 7 },
      { site: 'S1', time: iso(0), op: 'replace', value: 11, lamport: 7 },
    ],
  });
  const q1 = a.query('S1', iso(0), iso(0));
  const q2 = a.query('S2', iso(0), iso(0));
  assert.equal(q1.mean, 11);
  assert.equal(q2.mean, 22);
  // audit history is totally ordered by (lamport, site, seq)
  const audit = a.audit(`S1@${iso(0)}`);
  const order = audit.history.map((h) => [h.lamport, h.seq]);
  const sorted = [...order].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  assert.deepEqual(order, sorted);
});

test('undo validation: unknown batch, double undo, undo of undo', async () => {
  const dir = await freshDir();
  const a = await Archive.open(dir);
  await a.ingest([{ site: 'S1', time: iso(0), value: 1 }], { batchId: 'b1' });
  await assert.rejects(() => a.undo('nope'), /unknown batch/);
  await a.undo('b1');
  await assert.rejects(() => a.undo('b1'), /already undone/);
});
