import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.js';
import { check, evalExpr } from '../src/checker.js';
import { compile } from '../src/compiler.js';

test('lexer/parser: full trade statement', () => {
  const s = parse('trade T1 v1 on 2024-01-15 buy 100 US0378331005 @ 150.25 net fee 1.5');
  assert.equal(s.kind, 'trade');
  assert.equal(s.id, 'T1');
  assert.equal(s.version, 1);
  assert.equal(s.date, '2024-01-15');
  assert.equal(s.side, 'buy');
  assert.equal(s.qty, 100);
  assert.equal(s.isin, 'US0378331005');
  assert.equal(s.priceKind, 'net');
  assert.equal(evalExpr(s.priceExpr), 150.25);
  assert.equal(evalExpr(s.feeExpr), 1.5);
});

test('pratt: precedence, parens, unary minus, division', () => {
  const ev = (src) => evalExpr(parse(`trade T1 v1 on 2024-01-15 buy 1 US0378331005 @ ${src} net`).priceExpr);
  assert.equal(ev('2 + 3 * 4'), 14);
  assert.equal(ev('(2 + 3) * 4'), 20);
  assert.equal(ev('10 / 4'), 2.5);
  assert.equal(ev('100 - 2 * 30'), 40);
  assert.equal(ev('2 * 3 + 4 * 5'), 26);
  assert.equal(ev('-(5) + 8'), 3);
});

test('checker: negative quantity rejected with E_SIGN', () => {
  try {
    check(parse('trade T1 v1 on 2024-01-15 buy -5 US0378331005 @ 10 net'));
    assert.fail('should throw');
  } catch (e) { assert.equal(e.code, 'E_SIGN'); }
  try {
    check(parse('trade T1 v1 on 2024-01-15 buy 0 US0378331005 @ 10 net'));
    assert.fail('should throw');
  } catch (e) { assert.equal(e.code, 'E_SIGN'); }
});

test('checker: asset-type/direction typing (bond gross, equity net)', () => {
  assert.equal(check(parse('trade T1 v1 on 2024-01-15 buy 10 XS0987654321 @ 99 gross')).price, 99);
  try {
    check(parse('trade T1 v1 on 2024-01-15 buy 10 XS0987654321 @ 99 net'));
    assert.fail('should throw');
  } catch (e) { assert.equal(e.code, 'E_SIGN'); }
  try {
    check(parse('trade T1 v1 on 2024-01-15 sell 10 US0378331005 @ 99 gross'));
    assert.fail('should throw');
  } catch (e) { assert.equal(e.code, 'E_SIGN'); }
});

test('checker: negative price / fee rejected', () => {
  for (const src of [
    'trade T1 v1 on 2024-01-15 buy 1 US0378331005 @ 5 - 10 net',
    'trade T1 v1 on 2024-01-15 buy 1 US0378331005 @ 10 net fee 0 - 1',
  ]) {
    try { check(parse(src)); assert.fail('should throw'); }
    catch (e) { assert.equal(e.code, 'E_SIGN'); }
  }
});

test('compiler: emits stack bytecode for price and fee expressions', () => {
  const prog = compile(check(parse('trade T1 v1 on 2024-01-15 buy 1 US0378331005 @ 100 + 50 * 2 net fee 3')));
  const ops = prog.map((i) => i.op);
  assert.deepEqual(ops.slice(0, 5), ['PUSH', 'PUSH', 'PUSH', 'MUL', 'ADD']);
  assert.equal(ops[ops.length - 2], 'PUSH');
  assert.equal(ops[ops.length - 1], 'NEW_TRADE');
  const rev = compile(check(parse('revoke T1 v2 on 2024-01-15')));
  assert.deepEqual(rev, [{ op: 'REVOKE', id: 'T1', version: 2, date: '2024-01-15' }]);
});
