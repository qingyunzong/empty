'use strict';

// Acceptance C: independent brute-force enumeration over the alphabet
// {a,b,0,1} for all strings of length <= 8, cross-checking
//   1. DFA membership against a recursive AST matcher;
//   2. rule-set equivalence and the shortest/numerically-smallest witness.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRegex } = require('../lib/regex');
const { buildNfa, combineNfas, computeAlphabet, nfaToDfa, simulate } = require('../lib/automata');
const { compareRuleSets } = require('../lib/audit');
const { makeMatcher, makeSetMatcher, enumerateStrings, witnessOrder } = require('./helpers');

const ALPHABET = ['a', 'b', '0', '1'];
const MAX_LEN = 8;
const ALL_STRINGS = enumerateStrings(ALPHABET, MAX_LEN); // 87381 strings

test('enumeration sanity: 4^0 + ... + 4^8 strings', () => {
  assert.equal(ALL_STRINGS.length, (4 ** 9 - 1) / 3);
});

const MEMBERSHIP_PATTERNS = [
  '(a|b)*a(a|b)(a|b)',
  '[ab01]*1[ab01]*',
  '[^0]*',
  '(a?b)*',
  'a(b0|1a)*b?',
  '(0|1)(0|1)(0|1)?',
];

for (const pattern of MEMBERSHIP_PATTERNS) {
  test(`membership cross-check: ${pattern}`, () => {
    const nfa = buildNfa(parseRegex(pattern));
    const dfa = nfaToDfa(combineNfas([nfa]), computeAlphabet([nfa]));
    const independent = makeMatcher(pattern);
    for (const s of ALL_STRINGS) {
      assert.equal(simulate(dfa, s), independent(s), `pattern ${pattern}, string ${JSON.stringify(s)}`);
    }
  });
}

const PAIRS = [
  // [patternsA, patternsB, expectedEquiv, expectedWitness]
  [['(a|b)*'], ['(b|a)*'], true, null],
  [['a?a?'], ['(a|)(a|)'], true, null],
  [['(a*b*)*'], ['(a|b)*'], true, null],
  [['0*1*'], ['0*1*(1|)'], true, null],
  [['a', 'bb'], ['bb', 'a'], true, null],
  [['a*b*'], ['(a|b)*'], false, 'ba'],
  [['(ab)*'], ['a(ba)*b?'], false, ''],
  [['a|bb'], ['a|bbb'], false, 'bb'],
  [['a(a|b)*'], ['a(a|b)*a'], false, 'a'],
  [['(aa)*'], ['(a(aa)*)?'], false, 'a'],
  [['b*ab*'], ['(a|b)*'], false, ''],
  [['a*', 'b*'], ['(a|b)*'], false, 'ab'],
];

for (const [patternsA, patternsB, wantEquiv, wantWitness] of PAIRS) {
  const label = `{${patternsA}} vs {${patternsB}}`;
  test(`equivalence cross-check: ${label}`, () => {
    const res = compareRuleSets({ rules: patternsA }, { rules: patternsB });
    const matchA = makeSetMatcher(patternsA);
    const matchB = makeSetMatcher(patternsB);
    const diff = ALL_STRINGS.filter((s) => matchA(s) !== matchB(s)).sort(witnessOrder);

    assert.equal(res.equiv, diff.length === 0, `engine vs enumeration for ${label}`);
    assert.equal(res.equiv, wantEquiv, label);
    if (!res.equiv) {
      // The witness must lie in the symmetric difference and be the
      // shortest, then numerically smallest such string.
      assert.ok(diff.length > 0);
      assert.equal(res.witness, diff[0], label);
      assert.equal(res.witness, wantWitness, label);
      assert.notEqual(matchA(res.witness), matchB(res.witness));
      assert.ok(res.witness.length <= MAX_LEN);
    } else {
      assert.equal(res.witness, null);
    }
  });
}
