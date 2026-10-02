import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFile } from '../src/parser.js';
import { compileRuleset } from '../src/compiler.js';
import { evaluateRuleset } from '../src/evaluate.js';

const compile = (src) => compileRuleset(parseFile(src)[0]);

test('acceptance 2: tied strictest rules are all listed, stably sorted', () => {
  const rs = compile(`version 1
rule zg level global { deny when amount > 100CNY }
rule ag level global { deny when amount > 50CNY }
rule c1 level channel match channel payx { deny when amount > 10CNY }
rule c2 level channel match channel payx { review when count > 0 }`);
  const r = evaluateRuleset(rs, { channel: 'payx', amount: 500, count: 5 });
  assert.equal(r.decision, 'deny');
  assert.deepEqual(r.matched.map((m) => m.rule), ['ag', 'zg', 'c1']);
  // deterministic across runs regardless of source order
  const again = evaluateRuleset(rs, { channel: 'payx', amount: 500, count: 5 });
  assert.deepEqual(again.matched, r.matched);
});

test('outer deny beats inner allow (deny priority)', () => {
  const rs = compile(`version 1
rule g level global { deny when amount > 100CNY }
rule m level merchant match merchant M1 { allow when merchant in /M\\d+/ }`);
  const r = evaluateRuleset(rs, { merchant: 'M1', amount: 500 });
  assert.equal(r.decision, 'deny');
  assert.equal(r.outcome, 'deny');
});

test('no matching rule defaults to allow', () => {
  const rs = compile('version 1\nrule g level global { deny when amount > 100CNY }');
  assert.equal(evaluateRuleset(rs, { amount: 1 }).outcome, 'allow');
});

test('pending manual review is not a pass', () => {
  const rs = compile('version 1\nrule g level global { review when count > 5 }');
  const base = { count: 10 };
  assert.equal(evaluateRuleset(rs, base).outcome, 'review');
  assert.equal(evaluateRuleset(rs, { ...base, review: 'pending' }).outcome, 'review');
  assert.equal(evaluateRuleset(rs, { ...base, review: 'approved' }).outcome, 'allow');
  assert.equal(evaluateRuleset(rs, { ...base, review: 'rejected' }).outcome, 'deny');
});

test('match clauses scope channel/merchant rules', () => {
  const rs = compile(`version 1
rule c level channel match channel payx { deny when amount > 10CNY }
rule m level merchant match merchant M1 { deny when count > 0 }`);
  assert.equal(evaluateRuleset(rs, { channel: 'web', merchant: 'M2', amount: 50, count: 5 }).outcome, 'allow');
  assert.equal(evaluateRuleset(rs, { channel: 'payx', merchant: 'M2', amount: 50, count: 5 }).outcome, 'deny');
  assert.equal(evaluateRuleset(rs, { channel: 'web', merchant: 'M1', amount: 1, count: 5 }).outcome, 'deny');
});

test('money currency mismatch does not fire', () => {
  const rs = compile('version 1\nrule g level global { deny when amount > 100CNY }');
  assert.equal(evaluateRuleset(rs, { amount: 500, currency: 'USD' }).outcome, 'allow');
  assert.equal(evaluateRuleset(rs, { amount: 500, currency: 'CNY' }).outcome, 'deny');
});
