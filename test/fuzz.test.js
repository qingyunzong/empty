'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, compareHits } = require('../src/engine');

// Deterministic PRNG (mulberry32) so failures are reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHA = 'ab01 '; // small alphabet -> many overlaps

function randText(rand, maxLen) {
  const n = Math.floor(rand() * maxLen);
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHA[Math.floor(rand() * ALPHA.length)];
  return s;
}

function randExactPattern(rand) {
  const n = 1 + Math.floor(rand() * 3);
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHA[Math.floor(rand() * 3)]; // no space in patterns
  return s;
}

const REGEX_FRAGS = ['a', 'b', '0', '1', '[ab]', '[01]', 'a+', 'b?', '0*', '(a|b)', '(ab|ba)', 'a{1,2}', 'b{2}'];
function randRegex(rand) {
  const n = 1 + Math.floor(rand() * 3);
  let s = '';
  for (let i = 0; i < n; i++) s += REGEX_FRAGS[Math.floor(rand() * REGEX_FRAGS.length)];
  return s;
}

// Naive reference: double loop over rules x positions.
// exact: every startsWith occurrence; regex: longest slice matching ^(?:p)$ at each start.
function naiveHits(lines, rules) {
  const hits = [];
  lines.forEach((raw, line) => {
    const r = JSON.parse(raw);
    const memo = String(r.memo ?? '');
    for (const rule of rules.exact) {
      for (let i = 0; i + rule.pattern.length <= memo.length; i++) {
        if (memo.startsWith(rule.pattern, i)) {
          hits.push({ line, field: 'memo', start: i, length: rule.pattern.length, ruleId: rule.id, kind: 'exact', match: memo.slice(i, i + rule.pattern.length) });
        }
      }
    }
    for (const rule of rules.regex) {
      const text = String(r[rule.field] ?? '');
      const re = new RegExp(`^(?:${rule.pattern})$`);
      for (let i = 0; i < text.length; i++) {
        for (let L = text.length - i; L >= 1; L--) {
          if (re.test(text.slice(i, i + L))) {
            hits.push({ line, field: rule.field, start: i, length: L, ruleId: rule.id, kind: 'regex', match: text.slice(i, i + L) });
            break;
          }
        }
      }
    }
  });
  hits.sort(compareHits);
  return hits;
}

function strip(hits) {
  return hits.map(({ traceHash, ...rest }) => rest);
}

test('C: random small records vs naive double loop (50 seeds)', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const rand = rng(seed);
    const exact = [];
    const seen = new Set();
    for (let i = 0; i < 6; i++) {
      let p = randExactPattern(rand);
      while (seen.has(p)) p = randExactPattern(rand);
      seen.add(p);
      exact.push({ id: `E${i}`, pattern: p });
    }
    const regex = [];
    for (let i = 0; i < 4; i++) {
      regex.push({ id: `R${i}`, field: rand() < 0.7 ? 'memo' : 'amount', pattern: randRegex(rand) });
    }
    const rules = { exact, regex };
    const lines = [];
    for (let i = 0; i < 12; i++) {
      lines.push(JSON.stringify({
        clearingNo: `C${i}`,
        counterparty: 'X',
        currency: 'CNY',
        amount: randText(rand, 6),
        memo: randText(rand, 14),
      }));
    }
    const e = new Engine(rules);
    e.load(lines);
    const got = strip(e.scan().hits);
    const want = naiveHits(lines, rules);
    assert.deepEqual(got, want, `seed ${seed} rules ${JSON.stringify(rules)}`);
  }
});

test('D2: random patches -> incremental equals full rescan (30 seeds)', () => {
  for (let seed = 100; seed < 130; seed++) {
    const rand = rng(seed);
    const exact = [];
    const seen = new Set();
    for (let i = 0; i < 5; i++) {
      let p = randExactPattern(rand);
      while (seen.has(p)) p = randExactPattern(rand);
      seen.add(p);
      exact.push({ id: `E${i}`, pattern: p });
    }
    const regex = [{ id: 'R0', field: 'memo', pattern: randRegex(rand) }];
    const rules = { exact, regex };
    const lines = [];
    for (let i = 0; i < 20; i++) {
      lines.push(JSON.stringify({ clearingNo: `C${i}`, counterparty: 'X', currency: 'CNY', amount: '1', memo: randText(rand, 12) }));
    }
    const e = new Engine(rules);
    e.load(lines);
    for (let k = 0; k < 5; k++) {
      const idx = Math.floor(rand() * lines.length);
      const text = JSON.stringify({ clearingNo: `C${idx}`, counterparty: 'X', currency: 'CNY', amount: '1', memo: randText(rand, 12) });
      const p = e.patch(idx, text);
      lines[idx] = text;
      assert.deepEqual(p.window, { start: idx, end: idx });
      assert.equal(p.contextIntact, true);
    }
    const fresh = new Engine(rules);
    fresh.load(lines);
    assert.deepEqual(e.scan().hits, fresh.scan().hits, `seed ${seed}`);
    assert.equal(e.scan().proof.rootHash, fresh.scan().proof.rootHash);
  }
});
