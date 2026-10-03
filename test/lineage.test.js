import test from 'node:test';
import assert from 'node:assert/strict';
import { buildView, defectClosures } from '../src/lineage.js';
import { CyclicLineageError, UnknownParentError, ValidationError } from '../src/errors.js';

test('defect closure flows transitively through the lineage', () => {
  const records = [
    { batch: 'a', defects: ['d1'] },
    { batch: 'b', parents: ['a'], defects: ['d2'] },
    { batch: 'c', parents: ['b'], defects: [] },
  ];
  const closures = defectClosures(records);
  assert.deepEqual(closures.get('a'), ['d1']);
  assert.deepEqual(closures.get('b'), ['d1', 'd2']);
  assert.deepEqual(closures.get('c'), ['d1', 'd2']);
});

test('diamond lineage unions all ancestor defects', () => {
  const records = [
    { batch: 'base', defects: ['d0'] },
    { batch: 'left', parents: ['base'], defects: ['dL'] },
    { batch: 'right', parents: ['base'], defects: ['dR'] },
    { batch: 'merged', parents: ['left', 'right'], defects: [] },
  ];
  const closures = defectClosures(records);
  assert.deepEqual(closures.get('merged'), ['d0', 'dL', 'dR']);
});

test('cyclic lineage is rejected', () => {
  assert.throws(
    () => buildView([
      { batch: 'a', parents: ['b'] },
      { batch: 'b', parents: ['a'] },
    ]),
    CyclicLineageError,
  );
  assert.throws(() => buildView([{ batch: 'x', parents: ['x'] }]), CyclicLineageError);
});

test('unknown parent batch is rejected', () => {
  assert.throws(
    () => buildView([{ batch: 'a', parents: ['ghost'] }]),
    UnknownParentError,
  );
  assert.throws(
    () => buildView([{ batch: 'a', on: { merge: 'ghost' } }]),
    UnknownParentError,
  );
});

test('malformed records are rejected', () => {
  assert.throws(() => buildView([{ batch: 'a' }, { batch: 'a' }]), ValidationError);
  assert.throws(() => buildView([{ batch: 7 }]), ValidationError);
  assert.throws(() => buildView([{ batch: 'a', on: { fly: 'a' } }]), ValidationError);
});
