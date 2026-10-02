import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lex, parse } from '../src/index.js';

test('lexer: txn/acct literals, amounts, status keywords, comments', () => {
  const src = '# comment\ntxn:1001 acct:cash 12.50 7 SETTLED "hi"';
  const toks = lex(src);
  assert.equal(toks[0].type, 'txn');
  assert.equal(toks[0].value, 'txn:1001');
  assert.equal(toks[1].type, 'acct');
  assert.equal(toks[2].type, 'number');
  assert.equal(toks[2].isAmount, true);
  assert.equal(toks[2].value, 1250);
  assert.equal(toks[3].isAmount, false);
  assert.equal(toks[3].value, 7);
  assert.equal(toks[4].type, 'status');
  assert.equal(toks[4].value, 'SETTLED');
  assert.equal(toks[5].type, 'string');
  assert.equal(toks.at(-1).type, 'eof');
});

test('lexer: rejects bad characters with line/col', () => {
  assert.throws(() => lex('let x = @;'), (e) => e.code === 'E_PARSE' && e.line === 1);
});

test('pratt: arithmetic precedence 1 + 2 * 3', () => {
  const ast = parse(lex('param x = 1 + 2 * 3;'));
  const expr = ast.params[0].value;
  assert.equal(expr.op, '+');
  assert.equal(expr.left.value, 1);
  assert.equal(expr.right.op, '*');
  assert.equal(expr.right.left.value, 2);
  assert.equal(expr.right.right.value, 3);
});

test('pratt: not binds tighter than and, and tighter than or', () => {
  const ast = parse(lex('param x = not a and b or c;'));
  const expr = ast.params[0].value;
  assert.equal(expr.op, 'or');
  assert.equal(expr.left.op, 'and');
  assert.equal(expr.left.left.op, 'not');
  assert.equal(expr.right.name, 'c');
});

test('pratt: comparison and parentheses', () => {
  const ast = parse(lex('param x = (1 + 2) * 3 > 8 and true;'));
  const expr = ast.params[0].value;
  assert.equal(expr.op, 'and');
  assert.equal(expr.left.op, '>');
  assert.equal(expr.left.left.op, '*');
  assert.equal(expr.left.left.left.op, '+');
});

test('parser: for/when/revoke/let structure and field access', () => {
  const src = [
    'for tx in txns(txn:1, txn:2) {',
    '  let limit = 100.00 * 2;',
    '  when tx.status == SETTLED and tx.amount > limit {',
    '    revoke tx;',
    '  }',
    '}',
  ].join('\n');
  const ast = parse(lex(src));
  const loop = ast.body[0];
  assert.equal(loop.kind, 'For');
  assert.deepEqual(loop.list.ids, ['txn:1', 'txn:2']);
  assert.equal(loop.body[0].kind, 'Let');
  const when = loop.body[1];
  assert.equal(when.kind, 'When');
  assert.equal(when.cond.op, 'and');
  assert.equal(when.cond.left.kind, 'Binary');
  assert.equal(when.body[0].kind, 'Revoke');
});

test('parser: txns(*) wildcard', () => {
  const ast = parse(lex('for t in txns(*) { revoke t; }'));
  assert.equal(ast.body[0].list.kind, 'AllTxns');
});

test('parser: param inside loop is rejected', () => {
  assert.throws(
    () => parse(lex('for t in txns(*) { param x = 1; }')),
    (e) => e.code === 'E_PARSE',
  );
});
