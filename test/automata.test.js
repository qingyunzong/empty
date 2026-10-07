'use strict';

// Acceptance 1: intersection/complement combinations agree with brute-force
// enumeration of every word of length <= 7 over {a,b}.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../lib/regex');
const { compile, derivativeMatch } = require('../lib/compile');
const { minimize } = require('../lib/dfa');

const ALPHABET = ['a', 'b'];

function allWords(alphabet, maxLen) {
  const words = [''];
  let frontier = [''];
  for (let len = 1; len <= maxLen; len++) {
    const next = [];
    for (const w of frontier) {
      for (const c of alphabet) next.push(w + c);
    }
    words.push(...next);
    frontier = next;
  }
  return words;
}

function dfaMatch(d, word) {
  let s = d.start;
  for (const c of word) s = d.trans[s][d.alphabet.indexOf(c)];
  return d.accept[s];
}

function assertEquivalent(src, maxLen = 7) {
  const ast = parse(src);
  const d = minimize(compile(ast, ALPHABET, true));
  for (const w of allWords(ALPHABET, maxLen)) {
    assert.equal(
      dfaMatch(d, w),
      derivativeMatch(ast, w),
      `mismatch for ${src} on word ${JSON.stringify(w)}`,
    );
  }
}

test('fixed intersect/complement combinations match enumeration <=7', () => {
  const cases = [
    '~(a|b)*',                       // empty language
    '~EPS',                          // all non-empty words
    '~NIL',                          // all words
    '~(a*)&(a|b)*',                  // words containing b
    '(a|b)*abb(a|b)*&~((a|b)*aa(a|b)*)',
    'a(a|b)*a&~(a(a|b)*b)',
    '~(a*b*)&(a|b)(a|b)(a|b)(a|b)*', // long words not matching a*b*
    '(ab|ba)*&~(b(a|b)*)',
    '~~(a|bb)*',
    '(a&b)|(~NIL&(a|b))',
    'a+&~(aa(a|b)*)&(a|b)*',
  ];
  for (const src of cases) assertEquivalent(src);
});

// Seeded PRNG for reproducible random regexes.
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function genRegex(rand, depth) {
  if (depth === 0) {
    return ['a', 'b', 'EPS', 'NIL'][Math.floor(rand() * 4)];
  }
  const ops = ['union', 'concat', 'star', 'plus', 'intersect', 'complement',
    'intersect', 'complement', 'concat'];
  const op = ops[Math.floor(rand() * ops.length)];
  const sub = () => genRegex(rand, depth - 1);
  switch (op) {
    case 'union': return `(${sub()}|${sub()})`;
    case 'concat': return `(${sub()}${sub()})`;
    case 'star': return `(${sub()})*`;
    case 'plus': return `(${sub()})+`;
    case 'intersect': return `(${sub()}&${sub()})`;
    case 'complement': return `~(${sub()})`;
    default: throw new Error(op);
  }
}

test('random regexes with & and ~ match enumeration <=7', () => {
  const rand = mulberry32(20261008);
  for (let i = 0; i < 60; i++) {
    const src = genRegex(rand, 4);
    assertEquivalent(src);
  }
});
