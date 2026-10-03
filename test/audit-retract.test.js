import test from 'node:test';
import assert from 'node:assert/strict';
import { Processor } from '../src/processor.js';
import { HASH_A } from './helpers.js';

function stateOf(proc, caseId) {
  return proc.finalize().find((c) => c.case === caseId)?.state;
}

test('acceptance 2: audit retract rolls a released case back to QUAR', () => {
  const proc = new Processor();
  const events = [
    { kind: 'barcode', eventTs: 1000, frame: 1, case: 'C1', op: 'b1' },
    { kind: 'vision', eventTs: 1100, frame: 1, sku: 'S1', defect: null, hash: HASH_A, op: 'v1' },
    { kind: 'audit', eventTs: 1200, sku: 'S1', pass: true, op: 'a1' },
  ];
  events.forEach((ev, i) => proc.apply(i, ev));
  assert.equal(stateOf(proc, 'C1'), 'RELEASE');

  proc.apply(3, { kind: 'retract', eventTs: 1300, target: 'audit', id: 'a1' });
  assert.equal(stateOf(proc, 'C1'), 'QUAR', 'retracted audit revokes the release');

  // A fresh passing audit releases the case again.
  proc.apply(4, { kind: 'audit', eventTs: 1400, sku: 'S1', pass: true, op: 'a2' });
  assert.equal(stateOf(proc, 'C1'), 'RELEASE');

  // A failing audit after release also sends the case back to QUAR.
  proc.apply(5, { kind: 'audit', eventTs: 1500, sku: 'S1', pass: false, op: 'a3' });
  assert.equal(stateOf(proc, 'C1'), 'QUAR');
});

test('vision retract removes defect evidence but keeps the audit chain', () => {
  const proc = new Processor();
  const events = [
    { kind: 'barcode', eventTs: 1000, frame: 1, case: 'C1', op: 'b1' },
    { kind: 'vision', eventTs: 1050, frame: 1, sku: 'S1', defect: null, hash: HASH_A, op: 'v0' },
    { kind: 'vision', eventTs: 1100, frame: 1, sku: 'S1', defect: 'dent', hash: HASH_A, op: 'v1' },
    { kind: 'audit', eventTs: 1200, sku: 'S1', pass: true, op: 'a1' },
  ];
  events.forEach((ev, i) => proc.apply(i, ev));
  assert.equal(stateOf(proc, 'C1'), 'QUAR', 'defect evidence holds the case');

  proc.apply(4, { kind: 'retract', eventTs: 1300, target: 'vision', id: 'v1' });
  const finalized = proc.finalize();
  const c1 = finalized.find((c) => c.case === 'C1');
  assert.equal(c1.state, 'RELEASE', 'defect gone, audit still in force');
  assert.deepEqual(c1.defects, []);
  assert.ok(proc.effectiveAudit('S1'), 'audit chain preserved after vision retract');
});
