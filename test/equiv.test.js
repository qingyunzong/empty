'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compareRuleSets } = require('../lib/audit');

test('equivalent rule sets', () => {
  assert.deepEqual(compareRuleSets({ rules: ['(a|b)*'] }, { rules: ['(b|a)*'] }), {
    equiv: true,
    witness: null,
  });
  // Order and duplication inside a set do not matter.
  assert.equal(compareRuleSets({ rules: ['a', 'bb'] }, { rules: ['bb', 'a', 'a'] }).equiv, true);
  // Two empty sets are equivalent.
  assert.equal(compareRuleSets({ rules: [] }, { rules: [] }).equiv, true);
});

test('inequivalent rule sets yield the shortest, numerically smallest witness', () => {
  assert.deepEqual(compareRuleSets({ rules: ['a|bb'] }, { rules: ['a|bbb'] }), {
    equiv: false,
    witness: 'bb',
  });
  assert.deepEqual(compareRuleSets({ rules: [] }, { rules: ['a'] }), {
    equiv: false,
    witness: 'a',
  });
  // "0" (U+0030) sorts before "a" (U+0061): the numerically smallest
  // shortest witness wins.
  const res = compareRuleSets({ rules: ['a'] }, { rules: ['0'] });
  assert.equal(res.equiv, false);
  assert.equal(res.witness, '0');
});
