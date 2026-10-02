import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lex } from '../src/lexer.js';
import { parse } from '../src/parser.js';

const parseRule = (cond) =>
  parse(lex(`field temp: C; field current: A; rule r on all { alert info when ${cond}; }`))
    .decls.find((d) => d.kind === 'rule').body[0].expr;

test('parses temp > 80C for 5m as hold(compare)', () => {
  const e = parseRule('temp > 80C for 5m');
  assert.equal(e.kind, 'hold');
  assert.equal(e.duration, 300_000);
  assert.equal(e.operand.kind, 'compare');
  assert.equal(e.operand.op, '>');
  assert.equal(e.operand.right.unit, 'C');
});

test('Pratt precedence: or < and < not', () => {
  // a or b and not c  ==  or(a, and(b, not(c)))
  const e = parseRule('temp > 1C or temp > 2C and not temp > 3C');
  assert.equal(e.kind, 'logic');
  assert.equal(e.op, 'or');
  assert.equal(e.right.kind, 'logic');
  assert.equal(e.right.op, 'and');
  assert.equal(e.right.right.kind, 'not');
});

test('parentheses override precedence', () => {
  const e = parseRule('(temp > 1C or temp > 2C) and temp > 3C');
  assert.equal(e.op, 'and');
  assert.equal(e.left.kind, 'logic');
  assert.equal(e.left.op, 'or');
});

test('for binds to the nearest comparison only', () => {
  const e = parseRule('temp > 1C for 5m and current > 2A');
  assert.equal(e.kind, 'logic');
  assert.equal(e.left.kind, 'hold');
  assert.equal(e.right.kind, 'compare');
});

test('for after a non-comparison is a parse error with position', () => {
  assert.throws(
    () => parseRule('(temp > 1C and temp > 2C) for 5m'),
    (e) => e.phase === 'parse' && typeof e.line === 'number' && typeof e.col === 'number',
  );
});

test('parses full program: field/group/let/rule', () => {
  const ast = parse(lex(`
    field temp: C;
    group sensors = /^sensor-[0-9]+$/;
    let limit = 80C;
    rule overtemp on sensors {
      let hi = limit;
      alert critical when temp > hi for 5m;
    }
  `));
  assert.deepEqual(ast.decls.map((d) => d.kind), ['field', 'group', 'let', 'rule']);
  const rule = ast.decls[3];
  assert.equal(rule.target.kind, 'name');
  assert.equal(rule.target.name, 'sensors');
  assert.deepEqual(rule.body.map((s) => s.kind), ['let', 'alert']);
});
