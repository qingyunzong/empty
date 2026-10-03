import test from 'node:test';
import assert from 'node:assert/strict';
import { lex } from '../src/lexer.js';
import { parseExpression } from '../src/parser.js';
import { compileExpr } from '../src/compile.js';
import { evalCode } from '../src/vm.js';

const evalExpr = (src, env = {}) =>
  evalCode(compileExpr(parseExpression(src)), (p) => {
    if (!(p in env)) throw new Error(`unknown ref ${p}`);
    return env[p];
  });

test('lexer recognizes DSL keywords including reserve/confirm/release and logical-clock words', () => {
  const toks = lex('account order reserve confirm release invoke response pending capacity strategy limit invariant amount');
  const kws = toks.filter((t) => t.t === 'kw').map((t) => t.v);
  assert.deepEqual(kws, [
    'account', 'order', 'reserve', 'confirm', 'release',
    'invoke', 'response', 'pending', 'capacity', 'strategy', 'limit', 'invariant', 'amount',
  ]);
});

test('lexer skips comments and reports positions', () => {
  const toks = lex('# hello\naccount // trailing\n  acct');
  assert.deepEqual(toks.slice(0, 3).map((t) => [t.t, t.v]), [
    ['kw', 'account'], ['ident', 'acct'], ['eof', '<eof>'],
  ]);
  assert.equal(toks[0].line, 2);
});

test('pratt parser respects precedence and associativity', () => {
  assert.equal(evalExpr('1 + 2 * 3'), 7);
  assert.equal(evalExpr('(1 + 2) * 3'), 9);
  assert.equal(evalExpr('10 - 4 - 3'), 3);
  assert.equal(evalExpr('2 * 3 % 4'), 2);
  assert.equal(evalExpr('-3 + 1'), -2);
  assert.equal(evalExpr('1 + 2 <= 3 == true'), 1);
  assert.equal(evalExpr('1 < 2 && 2 < 3 || false'), 1);
  assert.equal(evalExpr('!false && not (1 > 2)'), 1);
});

test('capacity-constraint expressions compile to bytecode and resolve references', () => {
  const env = { 'alpha.used': 3, 'beta.used': 4, capacity: 10, 'alpha.limit': 6 };
  assert.equal(evalExpr('alpha.used + beta.used <= capacity', env), 1);
  assert.equal(evalExpr('alpha.used + 4 <= alpha.limit', env), 0);
});
