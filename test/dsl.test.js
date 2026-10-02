import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, parseDsl, typeCheck, compileProgram, runBytecode, evalPred } from '../src/index.js';

test('lexer: op and key pattern literals', () => {
  const toks = tokenize('a.op == op"w*" and b.key == key"x"', 't');
  assert.equal(toks[4].type, 'opPattern');
  assert.equal(toks[4].value, 'w*');
  assert.equal(toks[10].type, 'keyPattern');
  assert.equal(toks[10].value, 'x');
});

test('lexer: reports line and column on error', () => {
  assert.throws(
    () => tokenize('rule R {\n  @\n}', 'rules.dsl'),
    (e) => e.name === 'LexError' && e.line === 2 && e.col === 3 && e.file === 'rules.dsl',
  );
});

test('parser: Pratt precedence (and binds tighter than or)', () => {
  const ast = parseDsl('rule R { commutes(a, b): a.key == key"x" or a.key == key"y" and b.key == key"z"; }', 't');
  const expr = ast.rules[0].members[0].expr;
  assert.equal(expr.op, 'or');
  assert.equal(expr.right.op, 'and');
});

test('parser: not and parentheses', () => {
  const ast = parseDsl('rule R { commutes(a, b): not (a.key == key"x" or a.key == key"y"); }', 't');
  const expr = ast.rules[0].members[0].expr;
  assert.equal(expr.kind, 'not');
  assert.equal(expr.expr.op, 'or');
});

test('parser: syntax error carries line number', () => {
  assert.throws(
    () => parseDsl('rule R {\n  op read(key: string) -> int\n}', 'rules.dsl'),
    (e) => e.name === 'ParseError' && e.line === 3,
  );
});

test('types: comparing int with string is a static error with position', () => {
  assert.throws(
    () => typeCheck(parseDsl('rule R {\n  commutes(a, b): a.time < "nope";\n}', 'rules.dsl')),
    (e) => e.name === 'DslTypeError' && e.line === 2 && /requires int/.test(e.message),
  );
});

test('types: undefined variable and unknown field are rejected', () => {
  assert.throws(
    () => typeCheck(parseDsl('rule R { commutes(a, b): missing == 1; }', 't')),
    /undefined variable "missing"/,
  );
  assert.throws(
    () => typeCheck(parseDsl('rule R { commutes(a, b): a.bogus == 1; }', 't')),
    /unknown field "bogus"/,
  );
});

test('types: predicate expression must be boolean', () => {
  assert.throws(
    () => typeCheck(parseDsl('rule R { commutes(a, b): a.time; }', 't')),
    /must be boolean/,
  );
});

test('scoping: binders shadow outer lets; lets resolve at use site', () => {
  const src = `rule R {
    let bothWrites = a.op == op"write" and b.op == op"write";
    commutes(a, b): bothWrites;
    concurrent(x, y): x.key != y.key;
  }`;
  const compiled = compileProgram(typeCheck(parseDsl(src, 't')));
  const w = { op: 'write', key: 'x', value: 1, node: 'n', time: 0 };
  const r = { op: 'read', key: 'x', value: 1, node: 'n', time: 1 };
  assert.equal(evalPred(compiled, 'commutes', w, w), true);
  assert.equal(evalPred(compiled, 'commutes', w, r), false);
  // different binder names in the concurrent predicate
  assert.equal(evalPred(compiled, 'concurrent', { ...w, key: 'a' }, { ...w, key: 'b' }), true);
});

test('bytecode: short-circuit and pattern matching', () => {
  const src = 'rule R { commutes(a, b): a.op == op"w*" and b.key == key"user-?" or a.time >= 10; }';
  const compiled = compileProgram(typeCheck(parseDsl(src, 't')));
  const code = compiled.rules[0].preds[0].code;
  assert.ok(code.some((i) => i[0] === 'jz' || i[0] === 'jt'), 'uses short-circuit jumps');
  const mk = (over) => ({ op: 'write', key: 'user-1', value: null, node: 'n', time: 0, ...over });
  assert.equal(runBytecode(code, [mk(), mk()]), true);
  assert.equal(runBytecode(code, [mk({ op: 'read' }), mk()]), false);
  assert.equal(runBytecode(code, [mk({ op: 'read', time: 10 }), mk()]), true);
});
