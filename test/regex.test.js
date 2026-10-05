'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../src/regex');
const { loadRulesText } = require('../src/ruleset');

test('token atom expands position specs', () => {
  assert.equal(parse('HNF..').tokens.length, 6); // 3 channels x 2 history
  assert.equal(parse('.....').tokens.length, 192);
  assert.deepEqual(parse('LNDP0').tokens, ['LNDP0']);
});

test('character classes and negation', () => {
  assert.equal(parse('[HX]NF..').tokens.length, 12);
  assert.equal(parse('[^L]NF..').tokens.length, 18);
});

test('operators parse', () => {
  assert.equal(parse('HNF..*').type, 'star');
  assert.equal(parse('HNF..+').type, 'plus');
  assert.equal(parse('HNF..?').type, 'opt');
  assert.equal(parse('(HNF..|XNF..)').type, 'alt');
  assert.equal(parse('HNF..XNF..').type, 'concat');
});

test('invalid rules raise RULE_PARSE', () => {
  for (const bad of ['', '(HNF..', 'HNF.]', 'ZZZZZ', '(H|X)NF..', 'HNF..{2}']) {
    assert.throws(() => parse(bad), (e) => e.code === 'RULE_PARSE');
  }
});

test('rule longer than 60 chars rejected', () => {
  assert.throws(() => parse('.'.repeat(65)), (e) => e.code === 'RULE_PARSE');
});

test('named rules and @references resolve', () => {
  // 2 anonymous rules + 1 named rule (named rules belong to the union)
  const asts = loadRulesText('hi = [HX]NF..\n@hi\n@hi@hi');
  assert.equal(asts.length, 3);
});

test('RULE_CYCLE_UNSUPPORTED on cyclic references', () => {
  assert.throws(() => loadRulesText('a = @b\nb = @a'), (e) => e.code === 'RULE_CYCLE_UNSUPPORTED');
  assert.throws(() => loadRulesText('a = @a'), (e) => e.code === 'RULE_CYCLE_UNSUPPORTED');
  assert.throws(() => loadRulesText('a = @b\nb = @c\nc = @a'), (e) => e.code === 'RULE_CYCLE_UNSUPPORTED');
});
