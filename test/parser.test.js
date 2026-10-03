import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, ParseError } from '../src/parser.js';

test('parses temp>80C for 5m with for bound to the comparison', () => {
  const ast = parse('alert r level info on devices(d1) when temp > 80C for 5m');
  const expr = ast.statements[0].expr;
  assert.equal(expr.kind, 'for');
  assert.equal(expr.ms, 300000);
  assert.equal(expr.expr.kind, 'cmp');
  assert.equal(expr.expr.op, '>');
});

test('and binds tighter than or, not binds tighter than and', () => {
  const ast = parse('alert r level info on devices(d1) when temp > 1 or temp > 2 and not temp > 3');
  const expr = ast.statements[0].expr;
  assert.equal(expr.kind, 'or');
  assert.equal(expr.right.kind, 'and');
  assert.equal(expr.right.right.kind, 'not');
});

test('let alias statement', () => {
  const ast = parse('let limit = 80C\nalert r level info on devices(d1) when temp > limit');
  assert.equal(ast.statements[0].kind, 'let');
  assert.equal(ast.statements[0].name, 'limit');
});

test('mixed device groups: ids and regexes', () => {
  const ast = parse('alert r level info on devices(dev-1, /^lab-/) when temp > 1');
  const devs = ast.statements[0].devices;
  assert.deepEqual(devs.idents.map((d) => d.value), ['dev-1']);
  assert.deepEqual(devs.regexes.map((d) => d.value), ['^lab-']);
});

test('syntax errors carry line and column', () => {
  assert.throws(
    () => parse('let a = 1\nalert r level info when temp > 1'),
    (e) => e instanceof ParseError && e.line === 2 && typeof e.col === 'number',
  );
});
