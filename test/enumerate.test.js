// Acceptance 3: enumerate every defect/retract combination for <= 5 frames and
// compare the engine's quarantine set against an independent brute force.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, render } from '../src/engine.js';
import { HASH64 } from '../test-support/helpers.js';

// Brute-force reference: a case is quarantined iff any of its frames has a
// defect that was not retracted (single SKU, valid hashes, audit pass given).
function bruteForceQuar(frameCount, defectSet, retractSet) {
  const quar = [];
  for (const caseId of ['c1', 'c2']) {
    for (let i = 1; i <= frameCount; i++) {
      const frame = `f${i}`;
      const inCase = (i % 2 === 1) === (caseId === 'c1');
      if (inCase && defectSet.has(frame) && !retractSet.has(frame)) {
        quar.push(caseId);
        break;
      }
    }
  }
  return quar.sort();
}

function subsets(items) {
  const out = [new Set()];
  for (const it of items) {
    for (const s of [...out]) out.push(new Set([...s, it]));
  }
  return out;
}

test('enumerate all defect/retract combinations for <=5 frames', () => {
  let checked = 0;
  for (let n = 1; n <= 5; n++) {
    const frames = Array.from({ length: n }, (_, i) => `f${i + 1}`);
    for (const defectSet of subsets(frames)) {
      for (const retractSet of subsets([...defectSet])) {
        const engine = new Engine();
        let ts = 1000;
        for (let i = 1; i <= n; i++) {
          engine.apply({ type: 'barcode', eventTs: ts++, frame: `f${i}`, case: i % 2 === 1 ? 'c1' : 'c2', op: 'add' });
        }
        for (const f of frames) {
          const defect = defectSet.has(f) ? 'scratch' : null; // null = clean scan
          engine.apply({ type: 'vision', eventTs: ts++, frame: f, sku: 'skuA', defect, hash: HASH64, op: 'add' });
        }
        engine.apply({ type: 'audit', eventTs: ts++, sku: 'skuA', pass: true, op: 'add' });
        for (const f of retractSet) {
          engine.apply({ type: 'retract', eventTs: ts++, kind: 'vision', id: f });
        }
        const release = JSON.parse(render(engine).release);
        assert.deepEqual(
          release.quarantined,
          bruteForceQuar(n, defectSet, retractSet),
          `n=${n} defects=${[...defectSet]} retracts=${[...retractSet]}`,
        );
        checked++;
      }
    }
  }
  assert.ok(checked > 200, `expected broad enumeration, checked ${checked}`);
});
