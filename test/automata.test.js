'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRegex } = require('../lib/regex');
const {
  buildNfa,
  combineNfas,
  computeAlphabet,
  nfaToDfa,
  simulate,
  minimizeDfa,
  verifyCertificate,
} = require('../lib/automata');

function dfaFor(patterns) {
  const nfas = patterns.map((p) => buildNfa(parseRegex(p)));
  const alphabet = computeAlphabet(nfas);
  return nfaToDfa(combineNfas(nfas), alphabet);
}

test('DFA simulation matches expected strings', () => {
  const dfa = dfaFor(['a?b']);
  const cases = [['b', true], ['ab', true], ['a', false], ['abc', false], ['', false]];
  for (const [s, want] of cases) {
    assert.equal(simulate(dfa, s), want, JSON.stringify(s));
  }
});

test('minimization produces a verifiable certificate', () => {
  for (const patterns of [
    ['(a|b)*abb'],
    ['[^]*\\|USD\\|[^]*'],
    ['a?b?', 'c*(d|e)'],
    ['(aa|bb)*'],
  ]) {
    const dfa = dfaFor(patterns);
    const { certificate } = minimizeDfa(dfa);
    const check = verifyCertificate(dfa, certificate);
    assert.equal(check.valid, true, `${patterns}: ${check.reason}`);
  }
});

test('minimized DFA for (a|b)*abb has the expected state count', () => {
  const dfa = dfaFor(['(a|b)*abb']);
  const { minDfa } = minimizeDfa(dfa);
  // 4 Myhill-Nerode classes for "ends with abb" plus one dead class.
  assert.equal(minDfa.states.length, 5);
});

test('certificate verification detects tampering', () => {
  const dfa = dfaFor(['(a|b)*abb']);
  const { certificate } = minimizeDfa(dfa);

  const tampered = JSON.parse(JSON.stringify(certificate));
  tampered.blockTrans[1][0] = (tampered.blockTrans[1][0] + 1) % tampered.blocks.length;
  assert.equal(verifyCertificate(dfa, tampered).valid, false);

  const merged = JSON.parse(JSON.stringify(certificate));
  if (merged.blocks.length >= 2) {
    merged.blocks[0] = merged.blocks[0].concat(merged.blocks[1]);
    merged.blocks.splice(1, 1);
    assert.equal(verifyCertificate(dfa, merged).valid, false);
  }

  const noSeps = JSON.parse(JSON.stringify(certificate));
  noSeps.separators = {};
  assert.equal(verifyCertificate(dfa, noSeps).valid, false);
});

test('minimized DFA recognises the same language as the original', () => {
  const dfa = dfaFor(['a(b|c)*d', 'x?y']);
  const { minDfa } = minimizeDfa(dfa);
  for (const s of ['ad', 'abd', 'abcd', 'y', 'xy', 'a', 'd', 'xxy', 'ab']) {
    assert.equal(simulate(minDfa, s), simulate(dfa, s), s);
  }
});
