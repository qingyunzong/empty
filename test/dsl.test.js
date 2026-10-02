import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { check } from '../src/checker.js';
import { compile } from '../src/compiler.js';

const HEADER = 'period "2025-01"\n';

test('lexer recognizes account, debit/credit, period and batch tokens', () => {
  const types = tokenize('period "2025-01" batch B1 { allow t } debit cash 10').map((t) => t.type);
  assert.deepEqual(types, ['PERIOD', 'STRING', 'BATCH', 'IDENT', '{', 'ALLOW', 'IDENT', '}', 'DEBIT', 'IDENT', 'NUMBER', 'EOF']);
});

test('pratt parser respects operator precedence in balance conditions', () => {
  const program = parse(`${HEADER}
template t(a) {
  debit cash $a
  credit revenue $a
  balance debit * 2 + 0 == credit + debit
}`);
  const balance = program.templates[0].body.find((s) => s.type === 'balance');
  // (debit * 2) + 0 == credit + debit  ->  '*' binds tighter than '+', '==' loosest
  assert.equal(balance.expr.op, '==');
  assert.equal(balance.expr.left.op, '+');
  assert.equal(balance.expr.left.left.op, '*');
});

test('static check proves debit == credit symbolically (polynomial balance)', () => {
  const program = parse(`${HEADER}
template sale(gross, fee) {
  debit cash $gross
  credit revenue $gross - $fee
  credit fees $fee
}
batch B { period "2025-01" allow sale }`);
  assert.doesNotThrow(() => check(program));
});

test('E_BALANCE: statically unbalanced template is rejected at compile time', () => {
  const program = parse(`${HEADER}
template bad(x) {
  debit cash $x
  credit revenue $x + 1
}`);
  assert.throws(() => check(program), (e) => e.code === 'E_BALANCE');
});

test('E_BALANCE: explicit balance condition that does not hold is rejected', () => {
  const program = parse(`${HEADER}
template bad(x) {
  debit cash $x
  credit revenue $x
  balance debit == credit * 2
}`);
  assert.throws(() => check(program), (e) => e.code === 'E_BALANCE');
});

test('E_SCOPE: template parameters cannot leak across templates', () => {
  const program = parse(`${HEADER}
template a(secret) {
  debit cash $secret
  credit revenue $secret
}
template b() {
  debit cash $secret
  credit revenue $secret
}`);
  assert.throws(() => check(program), (e) => e.code === 'E_SCOPE');
});

test('E_TYPE: a parameter cannot be both an account and a value', () => {
  const program = parse(`${HEADER}
template bad(x) {
  debit x $x
  credit revenue $x
}`);
  assert.throws(() => check(program), (e) => e.code === 'E_TYPE');
});

test('E_PERIOD: batch binding an undeclared period is rejected at compile time', () => {
  const program = parse(`${HEADER}
template t(x) { debit cash $x credit revenue $x }
batch B { period "2099-01" allow t }`);
  assert.throws(() => check(program), (e) => e.code === 'E_PERIOD');
});

test('compiler emits bytecode for the vm', () => {
  const program = compile(check(parse(`${HEADER}
template t(x) { debit cash $x credit revenue $x }
batch B { period "2025-01" allow t }`)));
  const ops = program.templates.get('t').code.map((i) => i.op);
  assert.deepEqual(ops, ['PUSH_ARG', 'DEBIT', 'PUSH_ARG', 'CREDIT', 'PUSH_TOTAL', 'PUSH_TOTAL', 'SUB', 'CHECK_BALANCE']);
});
