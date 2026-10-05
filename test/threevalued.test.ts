import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FALSE, TRUE, UNKNOWN, Tri, triAnd, triNot, triOr,
  cmp, col, lit, evalBool, isNull, not,
} from '../src/index';

test('AND/OR/NOT 三值真值表', () => {
  const vals: Tri[] = [FALSE, UNKNOWN, TRUE];
  const andTable: Tri[][] = [
    [FALSE, FALSE, FALSE],
    [FALSE, UNKNOWN, UNKNOWN],
    [FALSE, UNKNOWN, TRUE],
  ];
  const orTable: Tri[][] = [
    [FALSE, UNKNOWN, TRUE],
    [UNKNOWN, UNKNOWN, TRUE],
    [TRUE, TRUE, TRUE],
  ];
  vals.forEach((a, i) => {
    vals.forEach((b, j) => {
      assert.equal(triAnd(a, b), andTable[i]![j]);
      assert.equal(triOr(a, b), orTable[i]![j]);
    });
  });
  assert.equal(triNot(FALSE), TRUE);
  assert.equal(triNot(UNKNOWN), UNKNOWN);
  assert.equal(triNot(TRUE), FALSE);
});

test('NULL 参与比较得到 UNKNOWN', () => {
  const schema = ['a'];
  const row = [null];
  for (const op of ['=', '<>', '<', '<=', '>', '>='] as const) {
    assert.equal(evalBool(cmp(op, col('a'), lit(1)), row, schema), UNKNOWN);
    assert.equal(evalBool(cmp(op, lit(1), col('a')), row, schema), UNKNOWN);
  }
  assert.equal(evalBool(cmp('=', col('a'), col('a')), row, schema), UNKNOWN, 'NULL = NULL 也是 UNKNOWN');
});

test('IS NULL / NOT(IS NULL)', () => {
  const schema = ['a'];
  assert.equal(evalBool(isNull(col('a')), [null], schema), TRUE);
  assert.equal(evalBool(isNull(col('a')), [0], schema), FALSE);
  assert.equal(evalBool(not(isNull(col('a'))), [null], schema), FALSE);
});

test('普通比较不受 NULL 影响', () => {
  const schema = ['a'];
  assert.equal(evalBool(cmp('=', col('a'), lit(1)), [1], schema), TRUE);
  assert.equal(evalBool(cmp('<', col('a'), lit(1)), [0], schema), TRUE);
  assert.equal(evalBool(cmp('=', col('a'), lit(1)), [2], schema), FALSE);
});
