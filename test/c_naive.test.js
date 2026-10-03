'use strict';

// 验收C：随机小报文与词表，扫描器结果与朴素双重循环对照一致。
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAutomata, scanLine, cmpHits } = require('../src/scanner');

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function naiveExact(pattern, text) {
  const hits = [];
  let i = text.indexOf(pattern);
  while (i !== -1) {
    hits.push({ start: i, end: i + pattern.length });
    i = text.indexOf(pattern, i + 1);
  }
  return hits;
}

function naiveRegex(pattern, text) {
  const re = new RegExp('^(?:' + pattern + ')$');
  const hits = [];
  for (let s = 0; s < text.length; s++) {
    for (let e = s + 1; e <= text.length; e++) {
      if (re.test(text.slice(s, e))) hits.push({ start: s, end: e });
    }
  }
  return hits;
}

const ALPHA = 'ab01';
function genAtom(rnd) {
  const r = rnd();
  if (r < 0.6) return ALPHA[Math.floor(rnd() * ALPHA.length)];
  if (r < 0.75) return '.';
  return rnd() < 0.5 ? '[ab]' : '[01]';
}
function genRegex(rnd, depth) {
  const r = rnd();
  if (depth > 2) return genAtom(rnd);
  if (r < 0.3) return genRegex(rnd, depth + 1) + genRegex(rnd, depth + 1);
  if (r < 0.45) return '(' + genRegex(rnd, depth + 1) + '|' + genRegex(rnd, depth + 1) + ')';
  if (r < 0.7) {
    const q = ['*', '+', '?'][Math.floor(rnd() * 3)];
    const base = rnd() < 0.5 ? genAtom(rnd) : '(' + genRegex(rnd, depth + 2) + ')';
    return base + q;
  }
  return genAtom(rnd);
}
function genText(rnd) {
  const n = Math.floor(rnd() * 13);
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHA[Math.floor(rnd() * ALPHA.length)];
  return s;
}

test('C: 200 random rounds, scanner matches naive double loop', () => {
  const rnd = mulberry32(20261003);
  for (let round = 0; round < 200; round++) {
    const text = genText(rnd);
    const rules = [];
    const seen = new Set();
    const nExact = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < nExact; i++) {
      const len = 1 + Math.floor(rnd() * 3);
      let p = '';
      for (let j = 0; j < len; j++) p += ALPHA[Math.floor(rnd() * ALPHA.length)];
      if (seen.has(p)) continue;
      seen.add(p);
      rules.push({ id: 'E' + i, type: 'exact', pattern: p });
    }
    const nRegex = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < nRegex; i++) {
      rules.push({ id: 'R' + i, type: 'regex', pattern: genRegex(rnd, 0) });
    }

    const expected = [];
    for (const r of rules) {
      const hs = r.type === 'exact' ? naiveExact(r.pattern, text) : naiveRegex(r.pattern, text);
      for (const h of hs) expected.push({ ...h, ruleId: r.id, kind: r.type });
    }
    expected.sort(cmpHits);

    const actual = scanLine(text, buildAutomata(rules));
    assert.deepEqual(actual, expected,
      `round ${round} text=${JSON.stringify(text)} rules=${JSON.stringify(rules)}`);
  }
});
