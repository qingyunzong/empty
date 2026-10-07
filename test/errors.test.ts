import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parse,
  run,
  RuleEvalError,
  RuleSyntaxError,
  type Context,
  type EvalErrorKind,
} from '../src/index.js';

// 语法错误：断言错误类型与 UTF-8 字节位置
const syntaxCases: Array<[string, number]> = [
  ['a &&', 4], // 表达式意外结束（eof 位置）
  ['', 0],
  ['a & b', 2], // 单个 &
  ['a | b', 2], // 单个 |
  ['a = 1', 2], // 单个 =
  ['(a || b', 7], // 缺少右括号
  ['a && )', 5], // 意外的记号 )
  ['1 < 2 < 3', 6], // 不允许连续比较，指向第二个 <
  ['1.5 == x', 0], // 小数不支持 bigint
  ['name == "abc', 8], // 字符串未闭合，指向引号
  ['a b', 2], // 意外的记号 b
  ['a && 坏', 5], // 无法识别的字符（多字节字符本身的位置）
  ['name == "中" &&', 16], // 多字节字符按字节计：4+1+2+1+1+3+1+1+2 = 16
];

for (const [source, bytePos] of syntaxCases) {
  test(`语法错误字节位置: ${JSON.stringify(source)} -> ${bytePos}`, () => {
    assert.throws(
      () => parse(source),
      (err: unknown) => {
        if (!(err instanceof RuleSyntaxError)) assert.fail('应为 RuleSyntaxError');
        assert.strictEqual(err.bytePos, bytePos);
        return true;
      },
    );
  });
}

// 求值错误：断言 kind 与字节位置
const evalCases: Array<[string, Context, EvalErrorKind, number]> = [
  ['missing == 1', {}, 'unknown-field', 0],
  ['a && missing == 1', { a: true }, 'unknown-field', 5],
  ['x > 1', { x: null }, 'null-ordering', 2],
  ['x <= 1', { x: null }, 'null-ordering', 2],
  ['a < b', { a: 1n, b: 'x' }, 'type-mismatch', 2],
  ['a < b', { a: true, b: false }, 'type-mismatch', 2], // 布尔不允许排序
  ['a && b', { a: 1n, b: true }, 'type-mismatch', 0], // 逻辑操作数非布尔
  ['x == 1', { x: 1.5 }, 'type-mismatch', 0], // 字段数值非整数
  ['age', { age: 5n }, 'not-boolean', 0], // 顶层结果非布尔
];

for (const [source, ctx, kind, bytePos] of evalCases) {
  test(`求值错误: ${source} -> ${kind}@${bytePos}`, () => {
    assert.throws(
      () => run(source, ctx),
      (err: unknown) => {
        if (!(err instanceof RuleEvalError)) assert.fail('应为 RuleEvalError');
        assert.strictEqual(err.kind, kind);
        assert.strictEqual(err.bytePos, bytePos);
        return true;
      },
    );
  });
}

test('被短路的未知字段不抛错，被访问才抛错', () => {
  assert.deepStrictEqual(run('false && missing == 1', {}), { result: false, reads: [] });
  assert.throws(() => run('true && missing == 1', {}), (err: unknown) => {
    if (!(err instanceof RuleEvalError)) assert.fail('应为 RuleEvalError');
    assert.strictEqual(err.kind, 'unknown-field');
    return true;
  });
});
