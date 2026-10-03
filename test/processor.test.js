import test from 'node:test';
import assert from 'node:assert/strict';
import { Processor, WATERMARK_DELAY_MS, WINDOW_MS } from '../src/processor.js';
import { HASH_A } from './helpers.js';

test('watermark = max event time - 3s; older events land in late.log', () => {
  const proc = new Processor();
  assert.equal(proc.apply(0, { kind: 'barcode', eventTs: 100_000, frame: 1, case: 'C1', op: 'b1' }), 'applied');
  assert.equal(proc.watermark, 100_000 - WATERMARK_DELAY_MS);
  const lateVision = { kind: 'vision', eventTs: 90_000, frame: 1, sku: 'S1', defect: 'dent', hash: HASH_A, op: 'v1' };
  assert.equal(proc.apply(1, lateVision), 'late');
  assert.equal(proc.late.length, 1);
  assert.equal(proc.late[0].reason, 'LATE');
  assert.equal(proc.late[0].seq, 1);
  assert.equal(proc.finalize()[0].defects.length, 0, 'late defect evidence is not applied');
});

test('events exactly at the watermark are still on time', () => {
  const proc = new Processor();
  proc.apply(0, { kind: 'barcode', eventTs: 100_000, frame: 1, case: 'C1', op: 'b1' });
  const atWatermark = { kind: 'vision', eventTs: 97_000, frame: 1, sku: 'S1', defect: null, hash: HASH_A, op: 'v1' };
  assert.equal(proc.apply(1, atWatermark), 'applied');
});

test('hash-barcode join only matches within the same event-time window', () => {
  const proc = new Processor();
  // barcode in window 0, vision in window 1: same frame, no join.
  proc.apply(0, { kind: 'barcode', eventTs: WINDOW_MS - 1, frame: 1, case: 'C1', op: 'b1' });
  proc.apply(1, { kind: 'vision', eventTs: WINDOW_MS + 1, frame: 1, sku: 'S1', defect: 'dent', hash: HASH_A, op: 'v1' });
  const c1 = proc.finalize().find((c) => c.case === 'C1');
  assert.deepEqual(c1.skus, []);
  assert.equal(c1.state, 'QUAR', 'unattributed case cannot be released');

  // vision in the same window joins.
  const proc2 = new Processor();
  proc2.apply(0, { kind: 'barcode', eventTs: 100, frame: 1, case: 'C1', op: 'b1' });
  proc2.apply(1, { kind: 'vision', eventTs: 200, frame: 1, sku: 'S1', defect: 'dent', hash: HASH_A, op: 'v1' });
  const joined = proc2.finalize().find((c) => c.case === 'C1');
  assert.deepEqual(joined.skus, ['S1']);
  assert.equal(joined.defects.length, 1);
});

test('barcode retract removes the frame from its case', () => {
  const proc = new Processor();
  proc.apply(0, { kind: 'barcode', eventTs: 100, frame: 1, case: 'C1', op: 'b1' });
  proc.apply(1, { kind: 'barcode', eventTs: 200, frame: 2, case: 'C1', op: 'b2' });
  proc.apply(2, { kind: 'retract', eventTs: 300, target: 'barcode', id: 'b2' });
  assert.deepEqual(proc.finalize()[0].frames, [1]);
  proc.apply(3, { kind: 'retract', eventTs: 400, target: 'barcode', id: 'b1' });
  assert.deepEqual(proc.finalize(), [], 'case disappears once all frames are retracted');
});

test('retract of an unknown id is ignored and counted', () => {
  const proc = new Processor();
  proc.apply(0, { kind: 'retract', eventTs: 100, target: 'vision', id: 'nope' });
  assert.equal(proc.unmatchedRetracts, 1);
});
