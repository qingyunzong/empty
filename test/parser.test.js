import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.js';
import { evalExpr } from '../src/types.js';

function exprOf(src, field = 'ratio') {
  const prog = parse(`action A { security S kind split ${field} ${src} exdate 2024-01-02 version 1 }`);
  return prog.body[0].fields.find((f) => f.name === field).expr;
}

test('pratt precedence: * binds tighter than +', () => {
  assert.equal(evalExpr(exprOf('1 + 2 * 3')).value.toString(), '7');
  assert.equal(evalExpr(exprOf('(1 + 2) * 3')).value.toString(), '9');
});

test('left associativity and division', () => {
  assert.equal(evalExpr(exprOf('10 / 2 / 5')).value.toString(), '1');
  assert.equal(evalExpr(exprOf('1 - 1/2')).value.toString(), '0.5');
  assert.equal(evalExpr(exprOf('1/(2+2)')).value.toString(), '0.25');
});

test('unary minus', () => {
  assert.equal(evalExpr(exprOf('-1 + 3')).value.toString(), '2');
  assert.equal(evalExpr(exprOf('-(1/2)')).value.toString(), '-0.5');
});

test('parses all statement kinds', () => {
  const prog = parse(`
action S1 { security AAPL kind split ratio 1/2 exdate 2024-06-10 version 1 }
apply S1
sell AAPL 40 on 2024-06-15
reverse S1
restate S1 { ratio 1/3 version 2 }
`);
  assert.deepEqual(prog.body.map((s) => s.k), ['action', 'apply', 'sell', 'reverse', 'restate']);
  assert.equal(prog.body[2].security, 'AAPL');
  assert.equal(prog.body[2].date, '2024-06-15');
});
