import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';

test('lexer recognizes customer number, date, regex literal', () => {
  const toks = tokenize('customer C0001; note /^[A-Z]+$/; bucket b { valid 2026-01-01 to 2026-12-31; }');
  const types = toks.map((t) => t.type);
  assert.ok(types.includes('CUSTOMER'));
  assert.ok(types.includes('REGEX'));
  assert.equal(toks.filter((t) => t.type === 'DATE').length, 2);
  assert.equal(toks.find((t) => t.type === 'CUSTOMER').value, 'C0001');
});

test('Pratt parser respects arithmetic and comparison precedence', () => {
  const prog = parse(`
    customer C0001;
    bucket b { limit 10; }
    approval A { reject freeze when 1 + 2 * 3 > 6 and not false; }
  `);
  const when = prog.approvals[0].rules[0].when;
  assert.equal(when.k, 'bin');
  assert.equal(when.op, 'and');
  const cmp = when.l;
  assert.equal(cmp.op, '>');
  assert.equal(cmp.l.op, '+');
  assert.equal(cmp.l.r.op, '*'); // 2*3 binds tighter than 1+
  assert.equal(when.r.op, 'not');
});

test('unless clause parses after when', () => {
  const prog = parse(`
    customer C0001;
    bucket b { limit 10; }
    approval A { reject freeze when amount > 5 unless note matches /^VIP-/ -> E_SCOPE; }
  `);
  const rule = prog.approvals[0].rules[0];
  assert.equal(rule.op, 'freeze');
  assert.equal(rule.unless.k, 'match');
  assert.equal(rule.code, 'E_SCOPE');
});
