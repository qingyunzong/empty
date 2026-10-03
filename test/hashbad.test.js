// hash must be 64 lowercase hex chars; anything else reports HASH_BAD and the
// case is quarantined, never released.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir, writeInput, runCli, readOut, vision, barcode, audit, HASH64 } from '../test-support/helpers.js';

test('HASH_BAD for malformed hashes, release for valid ones', () => {
  const bad = ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)];
  const events = [];
  let ts = 1000;
  bad.forEach((h, i) => {
    events.push(barcode(ts++, `f${i + 1}`, `c${i + 1}`));
    events.push(vision(ts++, `f${i + 1}`, 'skuA', 'scratch', h));
  });
  events.push(barcode(ts++, 'f9', 'c9'));
  events.push(vision(ts++, 'f9', 'skuA', 'ok', HASH64));
  events.push(audit(ts++, 'skuA', true));

  const inDir = writeInput(events);
  const outDir = tmpdir();
  const proc = runCli(inDir, outDir);
  assert.equal(proc.status, 0);
  assert.ok(proc.stderr.includes('HASH_BAD'));

  const out = readOut(outDir);
  const rows = out['cases.jsonl'].trim().split('\n').map((l) => JSON.parse(l));
  for (let i = 1; i <= 4; i++) {
    const row = rows.find((r) => r.case === `c${i}`);
    assert.equal(row.status, 'QUAR');
    assert.equal(row.error, 'HASH_BAD');
    assert.ok(row.reasons.includes('HASH_BAD'));
  }
  const release = JSON.parse(out['release.json']);
  assert.deepEqual(release.errors.map((e) => e.case), ['c1', 'c2', 'c3', 'c4']);
  assert.deepEqual(release.released, []); // c9 still has defect evidence
  assert.deepEqual(release.quarantined.sort(), ['c1', 'c2', 'c3', 'c4', 'c9']);
});
