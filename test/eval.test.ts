import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, parse, run, type Context } from '../src/index.js';

const check = (source: string, ctx: Context, result: boolean, reads: string[]): void => {
  assert.deepStrictEqual(run(source, ctx), { result, reads });
};

test('短路：&& 左侧为假则不访问右侧字段', () => {
  check('false && missing == 1', {}, false, []);
  check('a && missing == 1', { a: false }, false, ['a']);
});

test('短路：|| 左侧为真则不访问右侧字段', () => {
  check('true || missing == 1', {}, true, []);
  check('a || missing == 1', { a: true }, true, ['a']);
});

test('未访问的字段不报错（字段不存在也不抛错）', () => {
  check('ok == true || bad > 1', { ok: true }, true, ['ok']);
  check('ok == true && bad > 1', { ok: false }, false, ['ok']);
});

test('未访问的字段不参与 null 限制与类型校验', () => {
  check('false && x > 1', { x: null }, false, []); // x 为 null 但被短路
  check('true || y < 2', { y: 1.5 }, true, []); // y 非整数但被短路
});

test('实际读取字段顺序（含重复读取）', () => {
  check('a && b', { a: true, b: false }, false, ['a', 'b']);
  check('a || b', { a: false, b: true }, true, ['a', 'b']);
  check('x > 1 || y > 2', { x: 5n }, true, ['x']);
  check('x > 1 || y > 2', { x: 0n, y: 9n }, true, ['x', 'y']);
  check('a > 1 && a < 10 && b == 2', { a: 5n, b: 2n }, true, ['a', 'a', 'b']);
  check('!(a || b) && c', { a: false, b: false, c: true }, true, ['a', 'b', 'c']);
});

test('null 只允许等号比较', () => {
  check('x == null', { x: null }, true, ['x']);
  check('x != null', { x: null }, false, ['x']);
  check('x == null', { x: 5n }, false, ['x']);
  check('x != null', { x: 5n }, true, ['x']);
  check('null == null', {}, true, []);
  check('1 == null', {}, false, []);
  check('null != 1', {}, true, []);
});

test('数值为 bigint，超出 double 精度仍精确', () => {
  check('n == 9007199254740993', { n: 9007199254740993n }, true, ['n']);
  check('n > 9007199254740992', { n: 9007199254740993n }, true, ['n']);
});

test('整数 number 自动转 bigint 参与比较', () => {
  check('age >= 18', { age: 18 }, true, ['age']);
  check('age >= 18', { age: 17 }, false, ['age']);
  check('n == 1', { n: 1n }, true, ['n']);
  check('n != 1', { n: 1n }, false, ['n']);
});

test('字符串与布尔比较', () => {
  check('name == "abc"', { name: 'abc' }, true, ['name']);
  check('name < "b"', { name: 'abc' }, true, ['name']);
  check('flag == true', { flag: true }, true, ['flag']);
  check('flag != false', { flag: true }, true, ['flag']);
});

test('跨类型相等比较不报错（== 为假，!= 为真）', () => {
  check('a == b', { a: 1n, b: '1' }, false, ['a', 'b']);
  check('a != b', { a: 1n, b: '1' }, true, ['a', 'b']);
});

test('否定与括号', () => {
  check('!ok', { ok: false }, true, ['ok']);
  check('!(a && b)', { a: true, b: false }, true, ['a', 'b']);
  check('(a || b) && !(c || d)', { a: false, b: true, c: false, d: false }, true, [
    'a',
    'b',
    'c',
    'd',
  ]);
});

test('parse 一次、evaluate 多次复用同一 AST', () => {
  const ast = parse('age >= 18 && city == "sh"');
  assert.deepStrictEqual(evaluate(ast, { age: 20n, city: 'sh' }), {
    result: true,
    reads: ['age', 'city'],
  });
  assert.deepStrictEqual(evaluate(ast, { age: 10n }), { result: false, reads: ['age'] });
});
