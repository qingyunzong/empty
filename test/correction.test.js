import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { E } from '../src/errors.js';
import { tmpRoot, at } from './helpers.js';

function setup() {
  const root = tmpRoot();
  const store = new Store(root);
  store.initBatch({ batchId: 'B-100', baseline: 100, min: 95, max: 105, chunkSize: 2, at: at(0) });
  store.appendMeasure('B-100', { value: 106, at: at(1) }); // seq 1, out of tolerance
  store.appendMeasure('B-100', { value: 105, at: at(2) }); // seq 2
  return { root, store };
}

test('late correction appends compensation, never overwrites, changes final judgment', () => {
  const { store } = setup();
  // late correction of seq 1 arrives after seq 2
  store.appendCompensation('B-100', {
    refs: 1,
    value: 104,
    reason: 'sensor drift recalibration',
    at: at(3),
  });

  const view = store.decode('B-100');
  // final judgment changed by the late correction
  assert.equal(view.effective.seq, 3);
  assert.equal(view.effective.value, 104);
  assert.equal(view.effective.judgment, 'pass');
  assert.equal(view.correctionReason, 'sensor drift recalibration');

  // old value preserved in raw history, marked superseded, old judgment kept
  const corrected = view.history.find((h) => h.seq === 1);
  assert.equal(corrected.value, 106);
  assert.equal(corrected.judgment, 'fail');
  assert.equal(corrected.superseded, true);
  const comp = view.history.find((h) => h.seq === 3);
  assert.equal(comp.type, 'compensate');
  assert.equal(comp.refs, 1);
  assert.equal(comp.reason, 'sensor drift recalibration');
  assert.equal(view.history.filter((h) => h.seq === 1).length, 1);
});

test('audit replay: as-of decode reproduces the old judgment', () => {
  const { store } = setup();
  store.appendCompensation('B-100', { refs: 1, value: 104, reason: 'fix', at: at(3) });

  const before = store.decode('B-100', { asOfSeq: 1 });
  assert.equal(before.effective.value, 106);
  assert.equal(before.effective.judgment, 'fail');
  assert.equal(before.correctionReason, null);
  assert.equal(before.history.length, 2); // baseline + seq 1

  const mid = store.decode('B-100', { asOfSeq: 2 });
  assert.equal(mid.effective.value, 105);
  assert.equal(mid.effective.judgment, 'pass');

  const after = store.decode('B-100');
  assert.equal(after.effective.value, 104);
  assert.equal(after.effective.judgment, 'pass');
});

test('compensation referencing a nonexistent measurement returns E_REFERENCE', () => {
  const { store } = setup();
  assert.throws(
    () => store.appendCompensation('B-100', { refs: 99, value: 100, reason: 'bad' }),
    (err) => err.code === E.REFERENCE,
  );
  assert.throws(
    () => store.appendCompensation('B-100', { refs: 0, value: 100, reason: 'bad' }),
    (err) => err.code === E.REFERENCE,
  );
  assert.throws(
    () => store.appendCompensation('B-100', { refs: 1, value: 100, reason: '' }),
    /reason is required/,
  );
});

test('decode-time E_REFERENCE for a dangling compensation on disk', () => {
  const { store } = setup();
  // bypass append-time validation to simulate a hand-corrupted log
  const manifest = store._loadManifest('B-100');
  store._appendRecords(manifest, [
    { type: 'compensate', refs: 42, value: 100, reason: 'ghost', at: at(3) },
  ]);
  assert.throws(
    () => store.decode('B-100'),
    (err) => err.code === E.REFERENCE && /seq 42/.test(err.message),
  );
});

test('compensation of a compensation is allowed and chains', () => {
  const { store } = setup();
  store.appendCompensation('B-100', { refs: 1, value: 104, reason: 'first fix', at: at(3) });
  store.appendCompensation('B-100', { refs: 3, value: 103, reason: 'second fix', at: at(4) });
  const view = store.decode('B-100');
  assert.equal(view.effective.value, 103);
  assert.equal(view.correctionReason, 'second fix');
  assert.equal(view.history.find((h) => h.seq === 3).superseded, true);
});

test('late measurement with earlier timestamp is kept in append order', () => {
  const { store } = setup();
  // arrives last but carries an earlier measurement time
  store.appendMeasure('B-100', { value: 101, at: at(1) });
  const view = store.decode('B-100');
  assert.equal(view.history.length, 4);
  assert.equal(view.effective.seq, 3);
  assert.equal(view.effective.value, 101);
  // time index still locates by measurement time
  const hit = store.findAt('B-100', at(2));
  assert.equal(hit.seq, 2);
});
