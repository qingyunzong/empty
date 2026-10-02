import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from '../src/snapshot.js';
import { typeCell, encodeCell, compareCells, validateTolerance } from '../src/normalize.js';
import { makeRun, tmpdir } from '../testkit/helpers.js';

test('row sorting: shuffled CSV rows produce identical snapshot hash', () => {
  const dir = tmpdir();
  const schema = { tables: { t: { key: 'id' } } };
  const a = makeRun(`${dir}/a`, {
    params: { lr: 1 },
    schema,
    data: { t: 'id,v\n1,0.1\n2,0.2\n3,0.3\n' },
  });
  const b = makeRun(`${dir}/b`, {
    params: { lr: 1 },
    schema,
    data: { t: 'id,v\n3,0.3\n1,0.1\n2,0.2\n' },
  });
  assert.equal(buildSnapshot(a, 'a').hash, buildSnapshot(b, 'b').hash);
});

test('NULL (\\N) and empty string encode differently', () => {
  assert.equal(encodeCell(typeCell('\\N')), 'N');
  assert.equal(encodeCell(typeCell('')), 'S');
  assert.notEqual(encodeCell(typeCell('\\N')), encodeCell(typeCell('')));
});

test('float canonicalization: 1.0 == 1, -0 == 0, 1e-7 stable', () => {
  assert.equal(encodeCell(typeCell('1.0')), encodeCell(typeCell('1')));
  assert.equal(encodeCell(typeCell('-0')), 'F0');
  assert.equal(encodeCell(typeCell('1e-7')), encodeCell(typeCell('0.0000001')));
});

test('unknown markers ? and NaN encode as U', () => {
  assert.equal(encodeCell(typeCell('?')), 'U');
  assert.equal(encodeCell(typeCell('NaN')), 'U');
});

test('unknown comparison is undecided, never inconsistent', () => {
  const tol = { abs: 0, rel: 0 };
  assert.equal(compareCells('U', 'F5', tol), 'undecided');
  assert.equal(compareCells('F5', 'U', tol), 'undecided');
  assert.equal(compareCells('U', 'U', tol), 'equal');
});

const isETol = (e) => e.code === 'E_TOL';

test('tolerance validation rejects negative / NaN / infinite (E_TOL)', () => {
  assert.throws(() => validateTolerance({ abs: -1 }), isETol);
  assert.throws(() => validateTolerance({ rel: NaN }), isETol);
  assert.throws(() => validateTolerance({ abs: Infinity }), isETol);
  assert.throws(() => validateTolerance({ abs: '0.1' }), isETol);
  assert.deepEqual(validateTolerance({ abs: 0.5 }), { abs: 0.5, rel: 0 });
  assert.deepEqual(validateTolerance(undefined), { abs: 0, rel: 0 });
});
