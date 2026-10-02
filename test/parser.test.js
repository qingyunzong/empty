import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFile } from '../src/parser.js';

const firstExpr = (src) => parseFile(`version 1\nrule g level global { deny when ${src} }`)[0]
  .rules[0].statements[0].expr;

test('and binds tighter than or', () => {
  const e = firstExpr('amount > 1CNY or count > 2 and count < 5');
  assert.equal(e.kind, 'or');
  assert.equal(e.left.kind, 'cmp');
  assert.equal(e.right.kind, 'and');
});

test('not applies to the following comparison', () => {
  const e = firstExpr('not ip in 10.0.0.0/8 and count > 1');
  assert.equal(e.kind, 'and');
  assert.equal(e.left.kind, 'not');
  assert.equal(e.left.expr.kind, 'inCidr');
});

test('parentheses override precedence', () => {
  const e = firstExpr('(count > 1 or count > 2) and count < 5');
  assert.equal(e.kind, 'and');
  assert.equal(e.left.kind, 'or');
});

test('in targets: cidr, range, list, regex whitelist', () => {
  assert.equal(firstExpr('ip in 10.0.0.0/8').kind, 'inCidr');
  const range = firstExpr('amount in 100CNY..500CNY');
  assert.equal(range.kind, 'inRange');
  assert.equal(range.lo.amount, 100);
  assert.deepEqual(firstExpr('merchant in [M1, "M2"]').items, ['M1', 'M2']);
  assert.equal(firstExpr('merchant in /M10\\d+/').regex, 'M10\\d+');
});

test('parses levels, match clauses, override, multiple versions', () => {
  const src = `version 1
valid_from 2026-01-01T00:00:00Z
rule g level global { deny when amount > 1CNY }
rule c level channel match channel payx { override review when count > 3 }
version 2
rule g2 level global { allow when count < 1 }`;
  const [v1, v2] = parseFile(src);
  assert.equal(v1.version, 1);
  assert.equal(v1.validFrom, Date.parse('2026-01-01T00:00:00Z'));
  assert.equal(v1.rules[1].match.value, 'payx');
  assert.equal(v1.rules[1].statements[0].override, true);
  assert.equal(v2.version, 2);
});

test('syntax errors raise E_PARSE', () => {
  assert.throws(() => parseFile('version 1\nrule g level nowhere { deny when count > 1 }'), /E_PARSE/);
  assert.throws(() => parseFile('version 1\nrule g level global { count > 1 }'), /E_PARSE/);
  assert.throws(() => parseFile('version 1\nrule g level global match channel c { deny when count > 1 }'), /E_PARSE/);
});
