// Watermark = max event time - 3s; events older than the watermark are logged
// to late.log and do not affect state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir, writeInput, runCli, readOut, vision, barcode, audit } from '../test-support/helpers.js';

test('events older than the watermark go to late.log and are ignored', () => {
  const inDir = writeInput([
    barcode(10000, 'f1', 'c1'),
    vision(10100, 'f1', 'skuA', null), // clean scan, on-time
    audit(10200, 'skuA', true),
    barcode(20000, 'f2', 'c2'),          // watermark becomes 17000
    vision(16000, 'f1', 'skuA', 'scratch'), // late: 16000 < 17000
    vision(17000, 'f2', 'skuA', 'dent'),    // on-time: equal to watermark
  ]);
  const outDir = tmpdir();
  assert.equal(runCli(inDir, outDir).status, 0);
  const out = readOut(outDir);

  const late = out['late.log'].trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(late.length, 1);
  assert.equal(late[0].reason, 'LATE');
  assert.equal(late[0].event.frame, 'f1');
  assert.equal(late[0].watermark, 17000);

  const rows = out['cases.jsonl'].trim().split('\n').map((l) => JSON.parse(l));
  const c1 = rows.find((r) => r.case === 'c1');
  const c2 = rows.find((r) => r.case === 'c2');
  assert.equal(c1.status, 'RELEASED'); // late defect ignored
  assert.equal(c2.status, 'QUAR');     // on-time defect applied

  const release = JSON.parse(out['release.json']);
  assert.equal(release.watermark, 17000);
  assert.equal(release.maxEventTs, 20000);
});
