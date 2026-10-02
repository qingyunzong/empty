import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { checkRule } from '../src/types.js';

function check(src) {
  const ast = parse(tokenize(src, 'test.dsl'), 'test.dsl');
  checkRule(ast, 'test.dsl');
  return ast;
}

const BASE = `
rule "t" version 1 {
  param sampled: quantity
  param defects: quantity
  param severity: level
  const max_defects: quantity = 2
  const max_rate: ratio = 10%
  BODY
}
`;

function ruleWith(body) {
  return BASE.replace('BODY', body);
}

test('accepts a well-typed rule', () => {
  check(ruleWith(`
  when defects > max_defects or severity >= critical => REJECT
  when let rate: ratio = defects / sampled in sampled > 0 and rate > max_rate => REJECT
  when sampled >= 5 and defects <= max_defects => ACCEPT
  otherwise => CONTINUE
  `));
});

test('distinguishes quantity from ratio', () => {
  assert.throws(
    () => check(ruleWith('  when defects > max_rate => REJECT\n  otherwise => CONTINUE\n')),
    /cannot order-compare quantity with ratio/,
  );
});

test('quantity divided by quantity yields ratio', () => {
  const ast = check(ruleWith('  when defects / sampled > max_rate => REJECT\n  otherwise => CONTINUE\n'));
  assert.equal(ast.clauses[0].cond.left.exprType, 'ratio');
});

test('defect levels are ordered and comparable', () => {
  check(ruleWith('  when severity >= major => REJECT\n  otherwise => CONTINUE\n'));
  assert.throws(
    () => check(ruleWith('  when severity >= max_defects => REJECT\n  otherwise => CONTINUE\n')),
    /cannot order-compare level with quantity/,
  );
});

test('equality requires matching types', () => {
  assert.throws(
    () => check(ruleWith('  when severity == 2 => REJECT\n  otherwise => CONTINUE\n')),
    /cannot compare level with quantity/,
  );
});

test('dates and batch numbers are comparable within their type', () => {
  check(`
rule "t" version 1 {
  param day: date
  param lot: batch
  when day >= 2024-01-01 and lot == B2024-001 => ACCEPT
  otherwise => CONTINUE
}
`);
});

test('unknown identifier is a static error with line number', () => {
  assert.throws(
    () => check(ruleWith('  when missing_param > 1 => REJECT\n  otherwise => CONTINUE\n')),
    (err) => err.line === 8 && /unknown identifier 'missing_param'/.test(err.message),
  );
});

test('let bindings have lexical scope and shadow outer names', () => {
  // shadows the const max_defects inside this clause only
  check(ruleWith(`
  when let max_defects: quantity = 10 in defects > max_defects => REJECT
  when defects > max_defects => ACCEPT
  otherwise => CONTINUE
  `));
  // a let binding is not visible in the next clause
  assert.throws(
    () => check(ruleWith(`
  when let extra: quantity = 1 in defects > extra => REJECT
  when defects > extra => ACCEPT
  otherwise => CONTINUE
    `)),
    /unknown identifier 'extra'/,
  );
});

test('declared type must match inferred type', () => {
  assert.throws(
    () => check(ruleWith('  when let r: quantity = defects / sampled in r > 1 => REJECT\n  otherwise => CONTINUE\n')),
    /declared as quantity but has type ratio/,
  );
});

test('when condition must be boolean', () => {
  assert.throws(
    () => check(ruleWith('  when defects + 1 => REJECT\n  otherwise => CONTINUE\n')),
    /must be a boolean, got quantity/,
  );
});

test('duplicate parameter is rejected', () => {
  assert.throws(
    () => check(`
rule "t" version 1 {
  param a: quantity
  param a: quantity
  when a > 1 => REJECT
  otherwise => CONTINUE
}
`),
    /duplicate parameter 'a'/,
  );
});
