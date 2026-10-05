'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRulesText } = require('../src/ruleset');
const { checkEquivalence } = require('../src/automata');
const { bruteMatch, enumerateDivergence } = require('../src/brute');

// Acceptance C: for inequivalent rule sets the witness is the shortest
// diverging token string (ties broken by five-tuple lexicographic order),
// verifiable by independent enumeration over strings of length <= 8.

function assertWitnessVerified(rulesA, rulesB) {
  const astsA = loadRulesText(rulesA);
  const astsB = loadRulesText(rulesB);
  const r = checkEquivalence(astsA, astsB);
  assert.equal(r.equiv, false);
  assert.ok(r.witness.length <= 8, 'witness within enumeration bound');
  // the witness itself really diverges under the independent matcher
  const inA = astsA.some((a) => bruteMatch(a, r.witness));
  const inB = astsB.some((a) => bruteMatch(a, r.witness));
  assert.notEqual(inA, inB);
  // independent enumeration finds the exact same first divergence
  const found = enumerateDivergence(astsA, astsB, 8);
  assert.deepEqual(found, r.witness);
  return r;
}

test('C: single-token witness verified by enumeration', () => {
  const r = assertWitnessVerified('[HX]NF..', 'HNF..');
  assert.deepEqual(r.witness, ['XNFP0']); // lexicographically smallest XNF.. token
});

test('C: two-token witness verified by enumeration', () => {
  const r = assertWitnessVerified('(L....)(L....)', '(L....)(M....)');
  assert.deepEqual(r.witness, ['LNDP0', 'LNDP0']);
});

test('C: missing-vs-present empty string witness', () => {
  const r = assertWitnessVerified('(HNF..)?', 'HNF..');
  assert.deepEqual(r.witness, []); // empty string: accepted only by the first
});

test('C: star-vs-plus witness is the empty string', () => {
  const r = assertWitnessVerified('(HNF..)*', '(HNF..)+');
  assert.deepEqual(r.witness, []);
});

test('C: equivalent sets produce no witness', () => {
  const r = checkEquivalence(loadRulesText('[HX]NF..'), loadRulesText('HNF..|XNF..'));
  assert.equal(r.equiv, true);
  assert.equal(r.witness, null);
  assert.equal(enumerateDivergence(loadRulesText('[HX]NF..'), loadRulesText('HNF..|XNF..'), 2), null);
});
