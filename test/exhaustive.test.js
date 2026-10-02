'use strict';

// Acceptance 4: exhaustive enumeration of all strings of length <= 8 over
// {A,B}; the DFA pipeline must agree with an independent backtracking
// matcher on both occurrence and full-match semantics.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../src/regex');
const { occurrenceNfa, nfaFromAst, determinize, minimize, scanAccepts, fullMatchDfa } = require('../src/automata');
const matcher = require('../src/matcher');

const ALPHABET = ['A', 'B'];
const PATTERNS = [
  'A(B|A)*',
  '[AB]+B',
  'A?BA',
  '(AB|BA)(A|B)',
  'B*',
  'A.B',
  '(A|)B(A|BB)?',
];

function* allStrings(alphabet, maxLen) {
  yield '';
  let level = [''];
  for (let len = 1; len <= maxLen; len++) {
    const next = [];
    for (const s of level) {
      for (const c of alphabet) {
        next.push(s + c);
        yield s + c;
      }
    }
    level = next;
  }
}

test('DFA and backtracking matcher agree on all strings of length <= 8', () => {
  const strings = [...allStrings(ALPHABET, 8)];
  assert.equal(strings.length, 511);
  for (const pattern of PATTERNS) {
    const ast = parse(pattern);
    const occDfa = minimize(determinize(occurrenceNfa([ast], ALPHABET), ALPHABET), ALPHABET);
    const matchDfa = minimize(determinize(nfaFromAst(ast, ALPHABET), ALPHABET), ALPHABET);
    for (const s of strings) {
      assert.equal(
        scanAccepts(occDfa, s),
        matcher.search(ast, s, ALPHABET),
        `occurrence mismatch for /${pattern}/ on ${JSON.stringify(s)}`
      );
      assert.equal(
        fullMatchDfa(matchDfa, s),
        matcher.fullMatch(ast, s, ALPHABET),
        `full-match mismatch for /${pattern}/ on ${JSON.stringify(s)}`
      );
    }
  }
});

test('minimization is canonical: equivalent patterns, identical DFAs', () => {
  const pairs = [
    ['A(B|C)', 'AB|AC'],
    ['(A|B)*A', '(A|B)*A'],
    ['S+', 'SS*'],
    ['(AB)*', '(A(BA)*B)|'],
  ];
  for (const [p, q] of pairs) {
    const d1 = minimize(determinize(nfaFromAst(parse(p), ALPHABET), ALPHABET), ALPHABET);
    const d2 = minimize(determinize(nfaFromAst(parse(q), ALPHABET), ALPHABET), ALPHABET);
    assert.deepEqual(d1, d2, `/${p}/ and /${q}/ should minimize identically`);
  }
});
