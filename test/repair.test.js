'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkLog } = require('../src/check');

// 验收 B: 缺失复核给插入修复
test('B: missing review yields a single insert repair', () => {
  const result = checkLog('apply review release post', ['apply', 'release', 'post']);
  assert.equal(result.accept, false);
  assert.equal(result.repairError, null);
  assert.equal(result.repairs.length, 1);
  const plan = result.repairs[0];
  assert.equal(plan.cost, 1);
  assert.deepEqual(plan.ops, [{ op: 'insert', event: 'review', pos: 1 }]);
  assert.deepEqual(plan.result, ['apply', 'review', 'release', 'post']);
});

// 验收 C: 并列最优修复全部列出, 按事件名字典序
test('C: all tied optimal repairs listed in lexicographic order', () => {
  const result = checkLog('(apply|review) post', ['apply', 'review', 'post']);
  assert.equal(result.accept, false);
  assert.equal(result.repairs.length, 2);
  assert.deepEqual(
    result.repairs.map((p) => p.ops),
    [
      [{ op: 'delete', event: 'apply', pos: 0 }],
      [{ op: 'delete', event: 'review', pos: 1 }],
    ],
  );
  assert.deepEqual(result.repairs[0].result, ['review', 'post']);
  assert.deepEqual(result.repairs[1].result, ['apply', 'post']);
});

test('C: substitution costs delete+insert (2), never 1', () => {
  const result = checkLog('apply review', ['apply', 'release']);
  assert.equal(result.repairs[0].cost, 2);
  for (const plan of result.repairs) {
    assert.equal(plan.cost, 2);
    assert.deepEqual(plan.result, ['apply', 'review']);
  }
});

test('C: repair plans capped at 10 entries', () => {
  const result = checkLog('apply review release post', ['post']);
  assert.ok(result.repairs.length <= 10);
  assert.ok(result.repairs.length > 0);
  for (const plan of result.repairs) {
    assert.equal(plan.cost, result.repairs[0].cost);
  }
});

// 验收 E: 超过 K=6 无可修复报 NO_REPAIR_WITHIN_K
test('E: repair beyond K=6 reports NO_REPAIR_WITHIN_K, not unsatisfiable', () => {
  const source = 'apply review release post apply review release post';
  const result = checkLog(source, []);
  assert.equal(result.accept, false);
  assert.equal(result.repairs.length, 0);
  assert.equal(result.repairError.code, 'NO_REPAIR_WITHIN_K');
  assert.equal(result.repairError.minCost, 8);
  assert.equal(result.repairError.K, 6);
});

test('E: K is clamped to the global limit of 6', () => {
  const source = 'apply review release post apply review release post';
  const result = checkLog(source, [], { K: 100 });
  assert.equal(result.repairError.code, 'NO_REPAIR_WITHIN_K');
  assert.equal(result.repairError.K, 6);
});
