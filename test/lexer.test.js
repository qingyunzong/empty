import test from 'node:test';
import assert from 'node:assert/strict';
import { lex } from '../src/lexer.js';

const types = (src) => lex(src).map((t) => t.type);

test('lexes a full rule statement', () => {
  assert.deepEqual(
    types('rule r1 level channel { deny when amount > 100CNY and ip in 10.0.0.0/8 }'),
    ['KW', 'IDENT', 'KW', 'IDENT', 'LBRACE', 'KW', 'KW', 'IDENT', 'OP', 'MONEY',
     'KW', 'IDENT', 'KW', 'CIDR', 'RBRACE', 'EOF']);
});

test('lexes money, ranges, regex, lists, timestamps, comments', () => {
  const toks = lex('# c\nvalid_from 2026-01-01T00:00:00Z\namount in 100CNY..500.5USD and tag in /vip|promo/ and merchant in [M1, "M2"]');
  const ts = toks.find((t) => t.type === 'TS');
  assert.equal(ts.value, '2026-01-01T00:00:00Z');
  const money = toks.filter((t) => t.type === 'MONEY').map((t) => t.value);
  assert.deepEqual(money, ['100CNY', '500.5USD']);
  assert.ok(toks.some((t) => t.type === 'DOTDOT'));
  assert.equal(toks.find((t) => t.type === 'REGEX').value, 'vip|promo');
  assert.equal(toks.filter((t) => t.type === 'STRING').length, 1);
});

test('count range 1..10 does not confuse the number lexer', () => {
  const t = types('count in 1..10');
  assert.deepEqual(t, ['IDENT', 'KW', 'NUMBER', 'DOTDOT', 'NUMBER', 'EOF']);
});

test('unterminated regex and stray characters raise E_PARSE', () => {
  assert.throws(() => lex('tag in /abc'), /E_PARSE/);
  assert.throws(() => lex('amount = 5'), /E_PARSE/);
  assert.throws(() => lex('@'), /E_PARSE/);
});
