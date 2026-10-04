'use strict';

// Acceptance C: cross-check rule-set equivalence and minimal witnesses
// against an independent brute-force enumeration of all strings of
// length <= 8 over the alphabet {a, b, 0, 1}.

const test = require('node:test');
const assert = require('node:assert');
const { parse } = require('../src/regex');
const { equivPatterns } = require('../src/automata');

// ---------- independent matcher (recursive AST evaluation, no automata) ----------

function makeMatcher(ast) {
  const ids = new Map();
  let counter = 0;
  const idOf = (n) => {
    if (!ids.has(n)) ids.set(n, counter++);
    return ids.get(n);
  };
  const inRanges = (ranges, cp) => ranges.some(([lo, hi]) => lo <= cp && cp <= hi);

  function match(node, s, pos, memo) {
    const key = idOf(node) * (s.length + 1) + pos;
    if (memo.has(key)) return memo.get(key);
    let out;
    switch (node.type) {
      case 'eps':
        out = new Set([pos]);
        break;
      case 'class':
        out = new Set();
        if (pos < s.length && inRanges(node.ranges, s.codePointAt(pos))) out.add(pos + 1);
        break;
      case 'concat': {
        let cur = new Set([pos]);
        for (const part of node.parts) {
          const nxt = new Set();
          for (const q of cur) for (const r of match(part, s, q, memo)) nxt.add(r);
          cur = nxt;
        }
        out = cur;
        break;
      }
      case 'union':
        out = new Set();
        for (const opt of node.options) for (const r of match(opt, s, pos, memo)) out.add(r);
        break;
      case 'maybe':
        out = new Set([pos]);
        for (const r of match(node.node, s, pos, memo)) out.add(r);
        break;
      case 'star': {
        out = new Set([pos]);
        const stack = [pos];
        while (stack.length) {
          const p = stack.pop();
          for (const r of match(node.node, s, p, memo)) {
            if (!out.has(r)) {
              out.add(r);
              stack.push(r);
            }
          }
        }
        break;
      }
      default:
        throw new Error(`unknown node ${node.type}`);
    }
    memo.set(key, out);
    return out;
  }

  return (s) => match(ast, s, 0, new Map()).has(s.length);
}

// ---------- enumeration of strings, shortest first then code-point order ----------

const ALPHABET = ['0', '1', 'a', 'b']; // sorted by code point

function allStrings(maxLen) {
  const out = [''];
  let frontier = [''];
  for (let len = 1; len <= maxLen; len++) {
    const next = [];
    for (const s of frontier) {
      for (const c of ALPHABET) {
        const t = s + c;
        next.push(t);
        out.push(t);
      }
    }
    frontier = next;
  }
  return out;
}

const STRINGS = allStrings(8); // 87381 strings, ordered by (length, code point)

function enumResults(patterns) {
  const matchers = patterns.map((p) => makeMatcher(parse(p)));
  return STRINGS.map((s) => matchers.some((m) => m(s)));
}

function crossCheck(patternsA, patternsB) {
  const resA = enumResults(patternsA);
  const resB = enumResults(patternsB);
  let diffIdx = -1;
  for (let i = 0; i < STRINGS.length; i++) {
    if (resA[i] !== resB[i]) {
      diffIdx = i;
      break;
    }
  }
  const lib = equivPatterns(patternsA, patternsB);
  if (lib.equiv) {
    assert.strictEqual(diffIdx, -1, 'library says equivalent but enumeration found a difference');
  } else {
    assert.ok(diffIdx !== -1, 'enumeration found no difference but library produced a witness');
    assert.ok(lib.witness.length <= 8, 'witness should be within enumerated length for this corpus');
    assert.strictEqual(
      lib.witness,
      STRINGS[diffIdx],
      'witness must be the shortest, then numerically smallest distinguishing string'
    );
    assert.strictEqual(resA[diffIdx], lib.side === 'A', 'witness side must match enumeration');
  }
  return lib;
}

// ---------- seeded PRNG for reproducible random patterns ----------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genPattern(rng, depth) {
  const r = rng();
  if (depth <= 0 || r < 0.35) {
    if (rng() < 0.6) return ALPHABET[Math.floor(rng() * ALPHABET.length)];
    const size = 1 + Math.floor(rng() * 3);
    const chars = new Set();
    while (chars.size < size) chars.add(ALPHABET[Math.floor(rng() * ALPHABET.length)]);
    return '[' + [...chars].sort().join('') + ']';
  }
  const k = rng();
  if (k < 0.45) return genPattern(rng, depth - 1) + genPattern(rng, depth - 1);
  if (k < 0.65) return genPattern(rng, depth - 1) + '|' + genPattern(rng, depth - 1);
  if (k < 0.8) return '(' + genPattern(rng, depth - 1) + ')*';
  if (k < 0.9) return '(' + genPattern(rng, depth - 1) + ')?';
  return '(' + genPattern(rng, depth - 1) + ')';
}

function genPatterns(count, seed) {
  const rng = mulberry32(seed);
  const out = [];
  while (out.length < count) {
    const p = genPattern(rng, 3);
    if (p.length <= 80 && !out.includes(p)) out.push(p);
  }
  return out;
}

// ---------- tests ----------

test('handcrafted equivalent and non-equivalent pairs', () => {
  const equivalentPairs = [
    [['a*'], ['a*']],
    [['(0|1)*'], ['(1|0)*']],
    [['(ab)*'], ['(a(ba)*b)?']],
    [['a(a|b)*'], ['a(b|a)*']],
    [['(a|b)*abb'], ['(b|a)*abb']],
    [['0*1*'], ['0*', '1*', '00*11*']], // multi-rule sets
  ];
  for (const [a, b] of equivalentPairs) {
    const lib = crossCheck(a, b);
    assert.strictEqual(lib.equiv, true, `expected equivalent: ${a} vs ${b}`);
    assert.strictEqual(lib.witness, null);
  }

  const differentPairs = [
    [['a*'], ['aa*'], '', 'A'], // empty-string witness
    [['0(0|1)*1'], ['0(0|1)*0'], '00', 'B'],
    [['[01]*a[01]*'], ['[01]*b[01]*'], 'a', 'A'],
    [['0*1*'], ['0*', '1*'], '01', 'A'], // rule set vs single rule
    [['a', 'b'], ['(a|b)(a|b)?'], 'aa', 'B'],
  ];
  for (const [a, b, witness, side] of differentPairs) {
    const lib = crossCheck(a, b);
    assert.strictEqual(lib.equiv, false, `expected different: ${a} vs ${b}`);
    assert.strictEqual(lib.witness, witness);
    assert.strictEqual(lib.side, side);
  }
});

test('acceptance C: seeded random patterns cross-checked against enumeration (len <= 8)', () => {
  const patterns = genPatterns(16, 20261004);
  for (let i = 0; i < patterns.length; i += 2) {
    crossCheck([patterns[i]], [patterns[i + 1]]);
  }
  // also cross-check as two-rule sets
  for (let i = 0; i + 3 < patterns.length; i += 4) {
    crossCheck([patterns[i], patterns[i + 1]], [patterns[i + 2], patterns[i + 3]]);
  }
});
