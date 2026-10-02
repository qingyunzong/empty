import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';

function parseSource(src) {
  return parse(tokenize(src, 'test.dsl'), 'test.dsl');
}

const RULE = `
rule "r" version 2 {
  param sampled: quantity
  param defects: quantity
  const max_defects: quantity = 2
  when defects > max_defects => REJECT
  when sampled >= 5 and defects <= max_defects => ACCEPT
  otherwise => CONTINUE
}
`;

test('parses rule header, params, consts, clauses and otherwise', () => {
  const ast = parseSource(RULE);
  assert.equal(ast.name, 'r');
  assert.equal(ast.ruleVersion, 2);
  assert.deepEqual(ast.params.map((p) => [p.name, p.type]), [
    ['sampled', 'quantity'],
    ['defects', 'quantity'],
  ]);
  assert.equal(ast.consts.length, 1);
  assert.equal(ast.clauses.length, 2);
  assert.equal(ast.otherwise.verdict, 'CONTINUE');
});

test('pratt precedence: or < and < comparison < additive < multiplicative', () => {
  const ast = parseSource(`
rule "p" version 1 {
  param a: quantity
  when a + 1 * 2 > 3 and a < 10 or a == 7 => ACCEPT
  otherwise => CONTINUE
}
`);
  const cond = ast.clauses[0].cond;
  assert.equal(cond.op, 'or');
  assert.equal(cond.left.op, 'and');
  const cmp = cond.left.left;
  assert.equal(cmp.op, '>');
  assert.equal(cmp.left.op, '+');
  assert.equal(cmp.left.right.op, '*');
});

test('not binds looser than comparison, tighter than and', () => {
  const ast = parseSource(`
rule "p" version 1 {
  param a: quantity
  when not a == 1 and a > 0 => ACCEPT
  otherwise => CONTINUE
}
`);
  const cond = ast.clauses[0].cond;
  assert.equal(cond.op, 'and');
  assert.equal(cond.left.kind, 'un');
  assert.equal(cond.left.expr.op, '==');
});

test('let bindings parse with optional type annotations', () => {
  const ast = parseSource(`
rule "p" version 1 {
  param a: quantity
  param b: quantity
  when let r: ratio = a / b, s = r in s > 10% => REJECT
  otherwise => CONTINUE
}
`);
  const clause = ast.clauses[0];
  assert.equal(clause.lets.length, 2);
  assert.equal(clause.lets[0].declaredType, 'ratio');
  assert.equal(clause.lets[1].declaredType, null);
});

test('parse errors carry line numbers', () => {
  assert.throws(
    () => parseSource('rule "r" version 1 {\n  param a quantity\n}\n'),
    (err) => err.line === 2 && /expected ':'/.test(err.message),
  );
  assert.throws(
    () => parseSource('rule "r" version 1 {\n  param a: quantity\n  when a > => ACCEPT\n}\n'),
    (err) => err.line === 3 && /expected an expression/.test(err.message),
  );
});

test('rule without any clause is rejected', () => {
  assert.throws(
    () => parseSource('rule "r" version 1 {\n  param a: quantity\n}\n'),
    /at least one 'when' clause/,
  );
});
