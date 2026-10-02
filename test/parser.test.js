import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, ParseError } from '../src/parser.js';
import { compile, CompileError } from '../src/compiler.js';

test('pratt precedence: and binds tighter than or', () => {
  const ast = parse('nodes() where a == "1" or b == "2" and c == "3";');
  const where = ast.body[0].where;
  assert.equal(where.op, 'or');
  assert.equal(where.right.op, 'and');
});

test('not and parentheses override precedence', () => {
  const ast = parse('nodes() where not (a == "1" or b == "2");');
  const where = ast.body[0].where;
  assert.equal(where.type, 'not');
  assert.equal(where.operand.op, 'or');
});

test('let variables have lexical scope: shadowing inside blocks', () => {
  const ast = parse('let a = nodes(); { let a = ancestors(LOT-2025-0001); a; } a;');
  assert.equal(ast.body.length, 3);
  assert.equal(ast.body[1].type, 'block');
  compile(ast); // must compile: outer 'a' still visible after block
});

test('block-scoped variable is not visible outside its block', () => {
  const ast = parse('{ let inner = nodes(); } inner;');
  assert.throws(() => compile(ast), (e) => {
    assert.ok(e instanceof CompileError);
    assert.match(e.message, /undefined variable 'inner'/);
    return true;
  });
});

test('syntax errors carry line numbers', () => {
  assert.throws(() => parse('let a = nodes();\nlet b = ;'), (e) => {
    assert.ok(e instanceof ParseError);
    assert.equal(e.line, 2);
    return true;
  });
});

test('wrong builtin arity is a compile error', () => {
  assert.throws(() => compile(parse('shortestPath(LOT-2025-0001);')),
    /expects 2 argument/);
});
