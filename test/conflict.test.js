// Acceptance 4: a case spanning two SKUs is CONFLICT and must not be released;
// retracting the cross-SKU barcode restores the boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir, writeInput, runCli, readOut, vision, barcode, audit, retract } from '../test-support/helpers.js';

function statuses(out) {
  return out['cases.jsonl'].trim().split('\n').map((l) => JSON.parse(l));
}

test('cross-SKU conflict boundary', () => {
  const base = [
    barcode(1000, 'f1', 'c1'),
    vision(1010, 'f1', 'skuA', 'ok-surface'),
    barcode(1020, 'f2', 'c1'),
    vision(1030, 'f2', 'skuA', 'ok-surface'),
    audit(1040, 'skuA', true),
    audit(1050, 'skuB', true),
  ];
  const extraSameSku = [
    barcode(1060, 'f3', 'c1'),
    vision(1070, 'f3', 'skuA', 'ok-surface'),
  ];
  const extraOtherSku = [
    barcode(1060, 'f3', 'c1'),
    vision(1070, 'f3', 'skuB', 'ok-surface'),
  ];
  // 'ok-surface' is still defect evidence, so quarantine is defect-driven;
  // use retract of vision to clear evidence where release is expected.
  const clearDefects = [
    retract(1080, 'vision', 'f1'),
    retract(1090, 'vision', 'f2'),
    retract(1100, 'vision', 'f3'),
  ];

  // Boundary -: all frames same SKU -> releasable.
  {
    const inDir = writeInput([...base, ...extraSameSku, ...clearDefects]);
    const outDir = tmpdir();
    assert.equal(runCli(inDir, outDir).status, 0);
    const release = JSON.parse(readOut(outDir)['release.json']);
    assert.deepEqual(release.released, ['c1']);
    assert.deepEqual(release.conflicts, []);
  }

  // Boundary +: one frame with a different SKU -> CONFLICT, never released.
  {
    const inDir = writeInput([...base, ...extraOtherSku, ...clearDefects]);
    const outDir = tmpdir();
    assert.equal(runCli(inDir, outDir).status, 0);
    const out = readOut(outDir);
    const release = JSON.parse(out['release.json']);
    assert.deepEqual(release.released, []);
    assert.deepEqual(release.conflicts, ['c1']);
    const c1 = statuses(out).find((s) => s.case === 'c1');
    assert.equal(c1.status, 'CONFLICT');
    assert.deepEqual(c1.skus, ['skuA', 'skuB']);
  }

  // Retract the cross-SKU barcode -> case returns to single-SKU releasable.
  {
    const inDir = writeInput([
      ...base, ...extraOtherSku, ...clearDefects,
      retract(1110, 'barcode', 'f3'),
    ]);
    const outDir = tmpdir();
    assert.equal(runCli(inDir, outDir).status, 0);
    const out = readOut(outDir);
    const release = JSON.parse(out['release.json']);
    assert.deepEqual(release.released, ['c1']);
    const c1 = statuses(out).find((s) => s.case === 'c1');
    assert.deepEqual(c1.frames, ['f1', 'f2']);
  }
});
