import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Archive } from '../src/archive.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wxa-undo-'));
}

function approxEqual(a, b, eps = 1e-12) {
  if (a === null && b === null) return true;
  return a !== null && b !== null && Math.abs(a - b) < eps;
}

function buildArchive() {
  const archive = new Archive(tmpdir());
  // baseline ingest (batchId null)
  archive.ingest([
    { site: 'S1', validTime: '2026-03-01T00:00:00Z', value: 10, quality: 'good' },
    { site: 'S1', validTime: '2026-03-01T06:00:00Z', value: 20, quality: 'good' },
    { site: 'S2', validTime: '2026-03-01T00:00:00Z', value: 100, quality: 'good' },
  ]);
  // B1 corrects S1@00:00 -> 12
  archive.correct({
    batchId: 'B1',
    corrections: [{ op: 'replace', site: 'S1', validTime: '2026-03-01T00:00:00Z', value: 12, quality: 'good' }],
  });
  // B2 corrects the same key again -> 14, and touches S2
  archive.correct({
    batchId: 'B2',
    corrections: [
      { op: 'replace', site: 'S1', validTime: '2026-03-01T00:00:00Z', value: 14, quality: 'good' },
      { op: 'replace', site: 'S2', validTime: '2026-03-01T00:00:00Z', value: 200, quality: 'good' },
    ],
  });
  return archive;
}

test('undo only affects the target batch; lamport+site decides tip', () => {
  const archive = buildArchive();

  // before undo: S1@00:00 tip is B2's 14 (higher lamport wins)
  let audit = archive.audit('S1|2026-03-01T00:00:00Z');
  assert.equal(audit.tip.value, 14);
  assert.equal(audit.chain.length, 3);

  // undo B1 (the middle batch): tip must remain B2's 14
  archive.undo('B1');
  audit = archive.audit('S1|2026-03-01T00:00:00Z');
  assert.equal(audit.tip.value, 14);
  const b1event = audit.chain.find((c) => c.batchId === 'B1');
  const b2event = audit.chain.find((c) => c.batchId === 'B2');
  assert.equal(b1event.undone, true);
  assert.equal(b2event.undone, false);

  // S2 untouched by undo of B1
  const s2 = archive.audit('S2|2026-03-01T00:00:00Z');
  assert.equal(s2.tip.value, 200);

  // undo B2: tip falls back to the baseline ingest value 10 (B1 already undone)
  archive.undo('B2');
  audit = archive.audit('S1|2026-03-01T00:00:00Z');
  assert.equal(audit.tip.value, 10);
  assert.equal(audit.tip.batchId, null);

  // S2 falls back to its own baseline
  const s2after = archive.audit('S2|2026-03-01T00:00:00Z');
  assert.equal(s2after.tip.value, 100);

  // window aggregation reflects rollback
  const q = archive.query('S1', '2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z');
  assert.ok(approxEqual(q.weightedMean, (10 + 20) / 2));
  const qb = archive.query('S1', '2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z', { brute: true });
  assert.ok(approxEqual(q.weightedMean, qb.weightedMean));
});

test('undo of unknown or already-undone batch fails', () => {
  const archive = buildArchive();
  assert.throws(() => archive.undo('NOPE'), /unknown batchId/);
  archive.undo('B1');
  assert.throws(() => archive.undo('B1'), /already undone/);
});

test('concurrent history ordered by lamport then site', () => {
  const archive = buildArchive();
  // lamport order is the total order of the log; audit chain is lamport-sorted
  const audit = archive.audit('S1|2026-03-01T00:00:00Z');
  const lamports = audit.chain.map((c) => c.lamport);
  const sorted = [...lamports].sort((a, b) => a - b);
  assert.deepEqual(lamports, sorted);
  // as-of lamport query: after B1 but before B2, tip was 12
  const b2openLamport = archive.batches.get('B2').lamport;
  const asOf = archive.query('S1', '2026-03-01T00:00:00Z', '2026-03-01T01:00:00Z', {
    asOfLamport: b2openLamport - 1,
  });
  assert.ok(approxEqual(asOf.weightedMean, 12));
});

test('certificate proves rollback boundary', () => {
  const archive = buildArchive();
  archive.undo('B1');
  const cert = archive.certificate('B1');
  assert.equal(cert.undone, true);
  assert.equal(cert.affectedKeys.length, 1);
  const result = Archive.verifyCertificate(cert, archive);
  assert.equal(result.ok, true, JSON.stringify(result.errors));

  // certificate for a non-undone batch verifies too
  const cert2 = archive.certificate('B2');
  assert.equal(cert2.undone, false);
  assert.equal(Archive.verifyCertificate(cert2, archive).ok, true);
});
