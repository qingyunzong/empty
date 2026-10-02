import test from 'node:test';
import assert from 'node:assert/strict';
import { diffSnapshots } from '../src/diff.js';
import { buildSnapshot } from '../src/snapshot.js';
import { makeRun, tmpdir } from '../testkit/helpers.js';

const schema = { tables: { t: { key: 'id' } } };

function snaps(dataA, dataB, paramsA = { p: 1 }, paramsB = { p: 1 }, schemaObj = schema) {
  const dir = tmpdir();
  const a = buildSnapshot(makeRun(`${dir}/a`, { params: paramsA, schema: schemaObj, data: dataA }), 'a');
  const b = buildSnapshot(makeRun(`${dir}/b`, { params: paramsB, schema: schemaObj, data: dataB }), 'b');
  return [a, b];
}

test('symmetric diff: onlyInA / onlyInB / changed by primary key', () => {
  const [a, b] = snaps(
    { t: 'id,v\n1,10\n2,20\n3,30\n' },
    { t: 'id,v\n2,20\n3,31\n4,40\n' },
  );
  const d = diffSnapshots(a, b).tables.t;
  assert.deepEqual(d.onlyInA, ['F1']);
  assert.deepEqual(d.onlyInB, ['F4']);
  assert.deepEqual(d.changed, [{ key: 'F3', cells: [{ col: 'v', a: 30, b: 31 }] }]);
  assert.deepEqual(d.undecided, []);
});

test('param diff is reported with dotted paths', () => {
  const [a, b] = snaps({ t: 'id,v\n1,1\n' }, { t: 'id,v\n1,1\n' },
    { model: { lr: 0.1 }, seed: 7 }, { model: { lr: 0.2 }, seed: 7 });
  const d = diffSnapshots(a, b);
  assert.deepEqual(d.params, [{ path: 'model.lr', a: 0.1, b: 0.2 }]);
});

test('float boundary: exactly at abs tolerance is equal, just beyond differs', () => {
  const [a, b] = snaps(
    { t: 'id,v\n1,1.0\n2,1.0\n' },
    { t: 'id,v\n1,1.5\n2,1.5000000001\n' },
  );
  const d = diffSnapshots(a, b, { abs: 0.5, rel: 0 }).tables.t;
  assert.deepEqual(d.changed, [{ key: 'F2', cells: [{ col: 'v', a: 1, b: 1.5000000001 }] }]);
});

test('float boundary: relative tolerance', () => {
  const [a, b] = snaps(
    { t: 'id,v\n1,100\n2,100\n' },
    { t: 'id,v\n1,109\n2,112\n' },
  );
  const d = diffSnapshots(a, b, { abs: 0, rel: 0.1 }).tables.t;
  assert.deepEqual(d.changed.length, 1);
  assert.equal(d.changed[0].key, 'F2');
});

test('NULL cell vs value is a difference; NULL vs NULL is equal', () => {
  const [a, b] = snaps(
    { t: 'id,v\n1,\\N\n2,\\N\n' },
    { t: 'id,v\n1,5\n2,\\N\n' },
  );
  const d = diffSnapshots(a, b).tables.t;
  assert.deepEqual(d.changed, [{ key: 'F1', cells: [{ col: 'v', a: null, b: 5 }] }]);
});

test('missing column is distinct from NULL cell value', () => {
  const [a, b] = snaps(
    { t: 'id,v,extra\n1,\\N,9\n' },
    { t: 'id,v\n1,\\N\n' },
  );
  const d = diffSnapshots(a, b).tables.t;
  assert.deepEqual(d.missingColumns.onlyInA, ['extra']);
  assert.deepEqual(d.missingColumns.onlyInB, []);
  assert.deepEqual(d.changed, []);
});

test('unknown values yield undecided rows, not inconsistencies', () => {
  const [a, b] = snaps(
    { t: 'id,v\n1,?\n2,NaN\n3,5\n' },
    { t: 'id,v\n1,5\n2,5\n3,5\n' },
  );
  const d = diffSnapshots(a, b).tables.t;
  assert.deepEqual(d.changed, []);
  assert.equal(d.undecided.length, 2);
  assert.deepEqual(d.undecided.map((u) => u.key), ['F1', 'F2']);
});

test('missing primary key raises E_NO_KEY', () => {
  const [a, b] = snaps(
    { t: 'id,v\n1,1\n' },
    { t: 'id,v\n1,1\n' },
    { p: 1 }, { p: 1 },
    { tables: { t: {} } },
  );
  assert.throws(() => diffSnapshots(a, b), (e) => e.code === 'E_NO_KEY');
});

test('invalid tolerance raises E_TOL', () => {
  const [a, b] = snaps({ t: 'id,v\n1,1\n' }, { t: 'id,v\n1,1\n' });
  assert.throws(() => diffSnapshots(a, b, { abs: -0.1 }), (e) => e.code === 'E_TOL');
});
