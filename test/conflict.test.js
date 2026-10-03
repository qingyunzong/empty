import test from 'node:test';
import assert from 'node:assert/strict';
import { Processor } from '../src/processor.js';
import { HASH_A, HASH_B } from './helpers.js';

function setup(events) {
  const proc = new Processor();
  events.forEach((ev, i) => proc.apply(i, ev));
  return proc;
}

const base = [
  { kind: 'barcode', eventTs: 1000, frame: 1, case: 'C1', op: 'b1' },
  { kind: 'barcode', eventTs: 1001, frame: 2, case: 'C1', op: 'b2' },
];

test('acceptance 4: a case spanning two SKUs is CONFLICT and never released', () => {
  const proc = setup([
    ...base,
    { kind: 'vision', eventTs: 1002, frame: 1, sku: 'S1', defect: null, hash: HASH_A, op: 'v1' },
    { kind: 'vision', eventTs: 1003, frame: 2, sku: 'S2', defect: null, hash: HASH_A, op: 'v2' },
    { kind: 'audit', eventTs: 1004, sku: 'S1', pass: true, op: 'a1' },
    { kind: 'audit', eventTs: 1005, sku: 'S2', pass: true, op: 'a2' },
  ]);
  const c1 = proc.finalize().find((c) => c.case === 'C1');
  assert.equal(c1.state, 'CONFLICT');
  assert.deepEqual(c1.skus, ['S1', 'S2']);
  assert.ok(!proc.finalize().some((c) => c.state === 'CONFLICT' && c.state === 'RELEASE'));
});

test('acceptance 4: boundary - same SKU on every frame is not a conflict', () => {
  const proc = setup([
    ...base,
    { kind: 'vision', eventTs: 1002, frame: 1, sku: 'S1', defect: null, hash: HASH_A, op: 'v1' },
    { kind: 'vision', eventTs: 1003, frame: 2, sku: 'S1', defect: null, hash: HASH_B, op: 'v2' },
    { kind: 'audit', eventTs: 1004, sku: 'S1', pass: true, op: 'a1' },
  ]);
  assert.equal(proc.finalize().find((c) => c.case === 'C1').state, 'RELEASE');
});

test('acceptance 4: retracting one side of the conflict restores the single-SKU boundary', () => {
  const proc = setup([
    ...base,
    { kind: 'vision', eventTs: 1002, frame: 1, sku: 'S1', defect: null, hash: HASH_A, op: 'v1' },
    { kind: 'vision', eventTs: 1003, frame: 2, sku: 'S2', defect: null, hash: HASH_A, op: 'v2' },
    { kind: 'audit', eventTs: 1004, sku: 'S1', pass: true, op: 'a1' },
    { kind: 'audit', eventTs: 1005, sku: 'S2', pass: true, op: 'a2' },
  ]);
  assert.equal(proc.finalize()[0].state, 'CONFLICT');
  proc.apply(6, { kind: 'retract', eventTs: 1006, target: 'vision', id: 'v2' });
  assert.equal(proc.finalize()[0].state, 'RELEASE', 'conflict resolved down to one audited SKU');
});

test('acceptance 4: conflict is excluded from the release list', () => {
  const proc = setup([
    ...base,
    { kind: 'barcode', eventTs: 1002, frame: 3, case: 'C2', op: 'b3' },
    { kind: 'vision', eventTs: 1003, frame: 1, sku: 'S1', defect: null, hash: HASH_A, op: 'v1' },
    { kind: 'vision', eventTs: 1004, frame: 2, sku: 'S2', defect: null, hash: HASH_A, op: 'v2' },
    { kind: 'vision', eventTs: 1005, frame: 3, sku: 'S3', defect: null, hash: HASH_A, op: 'v3' },
    { kind: 'audit', eventTs: 1006, sku: 'S1', pass: true, op: 'a1' },
    { kind: 'audit', eventTs: 1007, sku: 'S2', pass: true, op: 'a2' },
    { kind: 'audit', eventTs: 1008, sku: 'S3', pass: true, op: 'a3' },
  ]);
  const cases = proc.finalize();
  assert.equal(cases.find((c) => c.case === 'C1').state, 'CONFLICT');
  assert.equal(cases.find((c) => c.case === 'C2').state, 'RELEASE');
});
