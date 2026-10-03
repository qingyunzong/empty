// Acceptance 2: retracting an audit rolls a released case back to QUAR;
// retracting vision removes defect evidence but keeps the audit chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir, writeInput, runCli, readOut, vision, barcode, audit, retract } from '../test-support/helpers.js';

test('vision retract removes defect evidence and case releases', () => {
  const inDir = writeInput([
    barcode(1000, 'f1', 'c1'),
    vision(1100, 'f1', 'skuA', 'scratch'),
    audit(1200, 'skuA', true),
    retract(1300, 'vision', 'f1'),
  ]);
  const outDir = tmpdir();
  assert.equal(runCli(inDir, outDir).status, 0);
  const out = readOut(outDir);
  const release = JSON.parse(out['release.json']);
  assert.deepEqual(release.released, ['c1']);
  const c1 = JSON.parse(out['cases.jsonl'].trim());
  assert.equal(c1.status, 'RELEASED');
  assert.deepEqual(c1.defects, []);
  // Audit chain preserved: the audit event is still on the trail, not retracted.
  assert.deepEqual(release.auditTrail, [{ seq: 3, sku: 'skuA', pass: true, retracted: false }]);
});

test('audit retract rolls a released case back to QUAR', () => {
  const inDir = writeInput([
    barcode(1000, 'f1', 'c1'),
    vision(1050, 'f1', 'skuA', null),
    audit(1100, 'skuA', true),
    retract(1200, 'audit', 'skuA'),
  ]);
  const outDir = tmpdir();
  assert.equal(runCli(inDir, outDir).status, 0);
  const out = readOut(outDir);
  const release = JSON.parse(out['release.json']);
  assert.deepEqual(release.released, []);
  assert.deepEqual(release.quarantined, ['c1']);
  const c1 = JSON.parse(out['cases.jsonl'].trim());
  assert.equal(c1.status, 'QUAR');
  assert.ok(c1.reasons.includes('NO_AUDIT_PASS'));
  // Audit chain kept: entry marked retracted, not deleted.
  assert.deepEqual(release.auditTrail, [{ seq: 3, sku: 'skuA', pass: true, retracted: true }]);
});

test('audit retract then re-audit releases again', () => {
  const inDir = writeInput([
    barcode(1000, 'f1', 'c1'),
    vision(1050, 'f1', 'skuA', null),
    audit(1100, 'skuA', true),
    retract(1200, 'audit', 'skuA'),
    audit(1300, 'skuA', true),
  ]);
  const outDir = tmpdir();
  assert.equal(runCli(inDir, outDir).status, 0);
  const release = JSON.parse(readOut(outDir)['release.json']);
  assert.deepEqual(release.released, ['c1']);
  assert.equal(release.auditTrail.length, 2);
});
