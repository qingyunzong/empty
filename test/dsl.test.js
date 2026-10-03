import test from 'node:test';
import assert from 'node:assert/strict';
import { Lexer } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { typecheck } from '../src/typecheck.js';
import { compileProgram } from '../src/compile.js';
import { run } from '../src/vm.js';
import { compile } from '../testkit/helpers.js';

function tokens(src) {
  const l = new Lexer(src);
  const out = [];
  for (;;) {
    const t = l.next();
    if (t.t === 'eof') break;
    out.push(`${t.t}:${t.v}`);
  }
  return out;
}

test('lexer: identifiers, keywords with hyphens, numbers, strings', () => {
  assert.deepEqual(tokens('op happens-before x1 "a\\n" 12 3.5'), [
    'ident:op', 'ident:happens-before', 'ident:x1', 'str:a\n', 'num:12', 'num:3.5',
  ]);
});

test('lexer: comments and two-char punctuation', () => {
  assert.deepEqual(tokens('a == b # note\n// c\nc -> d =~ e'), [
    'ident:a', 'punct:==', 'ident:b', 'ident:c', 'punct:->', 'ident:d', 'punct:=~', 'ident:e',
  ]);
});

test('lexer: unterminated string reports line', () => {
  assert.throws(() => tokens('x\n"abc'), /line 2: unterminated string/);
});

test('parser: arithmetic precedence via let constant folding', () => {
  const compiled = compile('op w(key: string)\nrule r {\n  let x = 1 + 2 * 3\n  commutes w(k), w(k) when x == 7\n}');
  assert.equal(compiled.constraints.length, 1);
  const ev = { id: 'e', op: 'w', key: 'x' };
  assert.equal(run(compiled.constraints[0].when, { slots: [ev, ev, 'x'] }), true);
});

test('parser: and/or short-circuit and not', () => {
  const compiled = compile('op w(key: string)\nrule r {\n  commutes w(k), w(k) when not (k == "y") and (1 == 1 or 1 == 2)\n}');
  const ev = { id: 'e', op: 'w', key: 'x' };
  assert.equal(run(compiled.constraints[0].when, { slots: [ev, ev, 'x'] }), true);
});

test('parser: happens-before infix and call forms are equivalent', () => {
  const compiled = compile(
    'op w(key: string)\nrule r {\n' +
    '  commutes w(_), w(_) when a happens-before b\n' +
    '  happens-before w(_), w(_) when happens-before(a, b)\n' +
    '}');
  assert.equal(compiled.constraints[0].when.filter((i) => i[0] === 'HB').length, 1);
  assert.equal(compiled.constraints[1].when.filter((i) => i[0] === 'HB').length, 1);
});

test('parser: regex literal and wildcard string as key patterns', () => {
  const compiled = compile('op w(key: string)\nrule r { commutes w(/user:.*/), w("tmp:*") }');
  const [reArg, wildArg] = compiled.constraints[0].patA.args.concat(compiled.constraints[0].patB.args);
  assert.equal(reArg.t, 'regex');
  assert.ok(reArg.re.test('user:42'));
  assert.equal(wildArg.t, 'regex');
  assert.ok(wildArg.re.test('tmp:9'));
  assert.ok(!wildArg.re.test('user:9'));
});

test('parser: =~ operator with regex and wildcard string', () => {
  const compiled = compile('op w(key: string)\nrule r { commutes w(k), w(k) when k =~ /a[0-9]+/ and k =~ "b*" }');
  const res = compiled.constraints[0].when;
  const ev = { id: 'e', op: 'w', key: 'x' };
  assert.equal(run(res, { slots: [ev, ev, 'a12'] }), false); // 'a12' does not match ^b.*$
  assert.equal(run(res, { slots: [ev, ev, 'b9'] }), false); // 'b9' does not match a[0-9]+
});

test('typecheck: undefined variable error carries line number', () => {
  assert.throws(
    () => compile('op w(key: string)\nrule r {\n  commutes w(k), w(k) when missing == 1\n}'),
    /line 3: undefined variable "missing"/);
});

test('typecheck: literal type mismatch against op parameter', () => {
  assert.throws(
    () => compile('op w(key: int)\nrule r { commutes w("s"), w(_) }'),
    /line 2: literal of type string does not match int parameter/);
});

test('typecheck: undeclared op in pattern', () => {
  assert.throws(() => compile('rule r { commutes w(_), w(_) }'), /undeclared op "w"/);
});

test('typecheck: pattern arity mismatch', () => {
  assert.throws(() => compile('op w(key: string)\nrule r { commutes w(a, b), w(_) }'), /takes 1 argument/);
});

test('typecheck: regex cannot match non-string parameter', () => {
  assert.throws(() => compile('op w(key: int)\nrule r { commutes w(/x/), w(_) }'), /regex pattern cannot match int/);
});

test('typecheck: unknown event field', () => {
  assert.throws(() => compile('op w(key: string)\nrule r { commutes w(_), w(_) when a.bogus == 1 }'), /unknown event field "bogus"/);
});

test('typecheck: when-expression must be bool', () => {
  assert.throws(() => compile('op w(key: string)\nrule r { commutes w(_), w(_) when 1 + 2 }'), /must be bool/);
});

test('scoping: nested blocks shadow lets lexically', () => {
  const compiled = compile(
    'op w(key: string)\nrule r {\n' +
    '  let t = 1\n' +
    '  commutes w(_), w(_) when t == 1\n' +
    '  {\n    let t = 2\n    commutes w(_), w(_) when t == 2\n  }\n' +
    '}');
  assert.equal(compiled.constraints.length, 2);
  const ev = { id: 'e', op: 'w', key: 'x' };
  assert.equal(run(compiled.constraints[0].when, { slots: [ev, ev] }), true);
  assert.equal(run(compiled.constraints[1].when, { slots: [ev, ev] }), true);
});

test('scoping: let inside a nested block is not visible outside', () => {
  assert.throws(
    () => compile('op w(key: string)\nrule r { { let t = 2 } commutes w(_), w(_) when t == 2 }'),
    /undefined variable "t"/);
});

test('compile: commutes builtin rejected inside commutes when-expression', () => {
  assert.throws(
    () => compile('op w(key: string)\nrule r { commutes w(_), w(_) when commutes(a, b) }'),
    /may not use the commutes builtin/);
});

test('compile: duplicate op declaration rejected', () => {
  assert.throws(() => compile('op w(key: string)\nop w(key: string)'), /duplicate operation "w"/);
});
