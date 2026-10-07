import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, type Expr } from '../src/index.js';

// AST 参考核验：每个用例手写参考 AST，与解析结果深度比对（含字节位置）。
const cases: Array<[string, Expr]> = [
  // && 优先级高于 ||
  [
    'a || b && c',
    {
      kind: 'or', bytePos: 2,
      left: { kind: 'field', name: 'a', bytePos: 0 },
      right: {
        kind: 'and', bytePos: 7,
        left: { kind: 'field', name: 'b', bytePos: 5 },
        right: { kind: 'field', name: 'c', bytePos: 10 },
      },
    },
  ],
  // 括号改变结构
  [
    '(a || b) && c',
    {
      kind: 'and', bytePos: 9,
      left: {
        kind: 'or', bytePos: 3,
        left: { kind: 'field', name: 'a', bytePos: 1 },
        right: { kind: 'field', name: 'b', bytePos: 6 },
      },
      right: { kind: 'field', name: 'c', bytePos: 12 },
    },
  ],
  // ! 与括号组合
  [
    '!(a || b) && !c',
    {
      kind: 'and', bytePos: 10,
      left: {
        kind: 'not', bytePos: 0,
        operand: {
          kind: 'or', bytePos: 4,
          left: { kind: 'field', name: 'a', bytePos: 2 },
          right: { kind: 'field', name: 'b', bytePos: 7 },
        },
      },
      right: {
        kind: 'not', bytePos: 13,
        operand: { kind: 'field', name: 'c', bytePos: 14 },
      },
    },
  ],
  // 比较 + 逻辑混合，数值为 bigint
  [
    'age >= 18 && city == "sh" || vip',
    {
      kind: 'or', bytePos: 26,
      left: {
        kind: 'and', bytePos: 10,
        left: {
          kind: 'cmp', op: '>=', bytePos: 4,
          left: { kind: 'field', name: 'age', bytePos: 0 },
          right: { kind: 'num', value: 18n, bytePos: 7 },
        },
        right: {
          kind: 'cmp', op: '==', bytePos: 18,
          left: { kind: 'field', name: 'city', bytePos: 13 },
          right: { kind: 'str', value: 'sh', bytePos: 21 },
        },
      },
      right: { kind: 'field', name: 'vip', bytePos: 29 },
    },
  ],
  // ! 作用于其后的整个比较表达式
  [
    '!a == b',
    {
      kind: 'not', bytePos: 0,
      operand: {
        kind: 'cmp', op: '==', bytePos: 3,
        left: { kind: 'field', name: 'a', bytePos: 1 },
        right: { kind: 'field', name: 'b', bytePos: 6 },
      },
    },
  ],
  // null 字面量
  [
    'x != null',
    {
      kind: 'cmp', op: '!=', bytePos: 2,
      left: { kind: 'field', name: 'x', bytePos: 0 },
      right: { kind: 'null', bytePos: 5 },
    },
  ],
  // 超出 double 精度的整数仍精确（bigint）
  [
    'n == 9007199254740993',
    {
      kind: 'cmp', op: '==', bytePos: 2,
      left: { kind: 'field', name: 'n', bytePos: 0 },
      right: { kind: 'num', value: 9007199254740993n, bytePos: 5 },
    },
  ],
  // 嵌套否定
  [
    '!(a && !b)',
    {
      kind: 'not', bytePos: 0,
      operand: {
        kind: 'and', bytePos: 4,
        left: { kind: 'field', name: 'a', bytePos: 2 },
        right: {
          kind: 'not', bytePos: 7,
          operand: { kind: 'field', name: 'b', bytePos: 8 },
        },
      },
    },
  ],
  // 字符串转义
  [
    "s == 'a\\nb'",
    {
      kind: 'cmp', op: '==', bytePos: 2,
      left: { kind: 'field', name: 's', bytePos: 0 },
      right: { kind: 'str', value: 'a\nb', bytePos: 5 },
    },
  ],
  // 布尔字面量
  [
    'ok == true',
    {
      kind: 'cmp', op: '==', bytePos: 3,
      left: { kind: 'field', name: 'ok', bytePos: 0 },
      right: { kind: 'bool', value: true, bytePos: 6 },
    },
  ],
];

for (const [source, expected] of cases) {
  test(`AST 参考核验: ${source}`, () => {
    assert.deepStrictEqual(parse(source), expected);
  });
}
