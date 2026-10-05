'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../src/regex');
const { loadRulesText } = require('../src/ruleset');
const { checkEquivalence, compileAsts, certificate } = require('../src/automata');

// Acceptance B: equivalent rule sets must produce identical certificates
// (state count + transition hash of the minimized DFA).

test('B: equivalent rules yield identical certificates', () => {
  const cases = [
    ['[HX]NF..', 'HNF..|XNF..'],
    ['HNF..|XNF..', 'XNF..|HNF..'], // union order irrelevant
    ['(HNF..)*', '((HNF..)(HNF..)*)?'], // L* == (L L*)?
    ['(HNF..)(XNF..)|(HNF..)(LNF..)', '(HNF..)[XL]NF..'],
    ['.....*', '.....*.....*'], // concatenation of Sigma* with itself
  ];
  for (const [a, b] of cases) {
    const r = checkEquivalence(loadRulesText(a), loadRulesText(b));
    assert.equal(r.equiv, true, `${a} ~= ${b}`);
    assert.equal(r.certA.hash, r.certB.hash);
    assert.equal(r.certA.states, r.certB.states);
    assert.equal(r.witness, null);
  }
});

test('B: certificate is deterministic across compilations', () => {
  const c1 = certificate(compileAsts(loadRulesText('XNF..\n(HNF..)(HNF..)')));
  const c2 = certificate(compileAsts(loadRulesText('XNF..\n(HNF..)(HNF..)')));
  assert.equal(c1.hash, c2.hash);
  assert.equal(c1.states, c2.states);
});

test('B: multi-rule file certificate equals single alternation', () => {
  const r = checkEquivalence(loadRulesText('XNF..\nL....'), loadRulesText('XNF..|L....'));
  assert.equal(r.equiv, true);
  assert.equal(r.certA.hash, r.certB.hash);
});

test('B: inequivalent rules yield different certificates', () => {
  const r = checkEquivalence(loadRulesText('[HX]NF..'), loadRulesText('HNF..'));
  assert.equal(r.equiv, false);
  assert.notEqual(r.certA.hash, r.certB.hash);
});

test('minimized DFA state counts are minimal', () => {
  // .....* (any string) minimizes to a single accepting state
  const c = certificate(compileAsts([parse('.....*')]));
  assert.equal(c.states, 1);
});
