import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareAddrStr, normAddr, parseAddr, formatAddr } from '../src/address.js';
import { Engine } from '../src/engine.js';
import { interpretAll } from '../src/interpreter.js';
import { formatValue } from '../src/value.js';

test('地址解析/格式化/排序（行优先）', () => {
  assert.equal(formatAddr(parseAddr('b12')!), 'B12');
  assert.equal(normAddr('a1'), 'A1');
  assert.ok(compareAddrStr('A1', 'B1') < 0);
  assert.ok(compareAddrStr('B1', 'A2') < 0, '行优先：B1 < A2');
  assert.ok(compareAddrStr('A2', 'A10') < 0);
});

test('基本求值与优先级', () => {
  const e = new Engine();
  e.setFormula('A1', '2 + 3 * 4');
  e.setFormula('A2', '(2 + 3) * 4');
  e.setFormula('A3', '-7 / 2');
  assert.equal(formatValue(e.getValue('A1')), 'INT 14');
  assert.equal(formatValue(e.getValue('A2')), 'INT 20');
  assert.equal(formatValue(e.getValue('A3')), 'INT -3', '整数除法向零截断');
});

test('空单元格按 0 处理，引用即依赖', () => {
  const e = new Engine();
  e.setFormula('A1', 'B1 + 5');
  assert.equal(formatValue(e.getValue('A1')), 'INT 5');
  assert.deepEqual(e.getDeps('A1'), ['B1']);
});

test('除零错误来源为自身，错误沿引用传播', () => {
  const e = new Engine();
  e.setFormula('A1', '1 / 0');
  e.setFormula('B1', 'A1 * 2');
  assert.equal(formatValue(e.getValue('A1')), 'ERR #DIV/0!@A1');
  assert.equal(formatValue(e.getValue('B1')), 'ERR #DIV/0!@A1');
});

test('多错误合并取最小来源地址（行优先）', () => {
  const e = new Engine();
  e.setFormula('A2', '1 / 0');
  e.setFormula('B1', '2 / 0');
  e.setFormula('C3', 'A2 + B1');
  // B1 行号更小：B1 < A2
  assert.equal(formatValue(e.getValue('C3')), 'ERR #DIV/0!@B1');
  e.setFormula('B1', '7');
  assert.equal(formatValue(e.getValue('C3')), 'ERR #DIV/0!@A2');
});

test('IF 动态条件：只依赖选中分支，未选中分支的错误不传播', () => {
  const e = new Engine();
  e.setFormula('A1', '1');
  e.setFormula('B1', '10');
  e.setFormula('C1', '1 / 0');
  e.setFormula('D1', 'IF(A1, B1, C1)');
  assert.equal(formatValue(e.getValue('D1')), 'INT 10');
  assert.deepEqual(e.getDeps('D1'), ['A1', 'B1']);

  e.setFormula('A1', '0');
  assert.equal(formatValue(e.getValue('D1')), 'ERR #DIV/0!@C1');
  assert.deepEqual(e.getDeps('D1'), ['A1', 'C1']);
});

test('增量更新沿依赖链传播', () => {
  const e = new Engine();
  e.setFormula('A1', '1');
  e.setFormula('B1', 'A1 + 1');
  e.setFormula('C1', 'B1 * 10');
  assert.equal(formatValue(e.getValue('C1')), 'INT 20');
  e.setFormula('A1', '5');
  assert.equal(formatValue(e.getValue('B1')), 'INT 6');
  assert.equal(formatValue(e.getValue('C1')), 'INT 60');
});

test('环检测：来源为环上最小地址，环解除后恢复', () => {
  const e = new Engine();
  e.setFormula('A1', 'B1 + 1');
  e.setFormula('B1', 'A1 + 1');
  assert.equal(formatValue(e.getValue('A1')), 'ERR #CYCLE!@A1');
  assert.equal(formatValue(e.getValue('B1')), 'ERR #CYCLE!@A1');
  e.setFormula('B1', '41');
  assert.equal(formatValue(e.getValue('A1')), 'INT 42');
  assert.equal(formatValue(e.getValue('B1')), 'INT 41');
});

test('语法错误为 #ERROR!，来源为自身', () => {
  const e = new Engine();
  e.setFormula('A1', '1 +');
  e.setFormula('B1', 'A1 + 1');
  assert.equal(formatValue(e.getValue('A1')), 'ERR #ERROR!@A1');
  assert.equal(formatValue(e.getValue('B1')), 'ERR #ERROR!@A1');
});

test('清除公式后按空单元格处理', () => {
  const e = new Engine();
  e.setFormula('A1', '9');
  e.setFormula('B1', 'A1');
  assert.equal(formatValue(e.getValue('B1')), 'INT 9');
  e.setFormula('A1', '');
  assert.equal(formatValue(e.getValue('B1')), 'INT 0');
});

test('全表解释器基本语义一致', () => {
  const formulas = new Map<string, string>([
    ['A1', '1'],
    ['B1', 'A1 + 2'],
    ['C1', 'IF(A1, B1, 1 / 0)'],
    ['D1', 'C1'],
  ]);
  const r = interpretAll(formulas);
  assert.equal(formatValue(r.values.get('C1')!), 'INT 3');
  assert.deepEqual(r.deps.get('C1'), ['A1', 'B1']);
  assert.deepEqual(r.deps.get('D1'), ['C1']);
});
