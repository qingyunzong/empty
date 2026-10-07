'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRuleSet } = require('../src/rules');

test('cyclic rule references raise RULE_CYCLE_UNSUPPORTED', () => {
  assert.throws(
    () => loadRuleSet('x = @y\ny = @x\n'),
    (err) => err.code === 'RULE_CYCLE_UNSUPPORTED'
  );
  assert.throws(
    () => loadRuleSet('loop = [a0****] @loop\n'),
    (err) => err.code === 'RULE_CYCLE_UNSUPPORTED'
  );
});

test('named references expand when acyclic', () => {
  const rs = loadRuleSet('big = [a3****]\nmain = @big [****h1]\n');
  assert.ok(rs.certificate.states > 0);
  assert.deepEqual(rs.order, ['big', 'main']);
});

test('parse errors are reported', () => {
  assert.throws(() => loadRuleSet('r = [a9****]\n'), (err) => err.code === 'RULE_PARSE');
  assert.throws(() => loadRuleSet('r = ([a0****]\n'), (err) => err.code === 'RULE_PARSE');
});
