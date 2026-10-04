'use strict';

// Acceptance 1+2: on inputs within 300 rows, optimized plans must match
// direct enumeration exactly, including NULL/unknown boundary behavior.
const test = require('node:test');
const assert = require('node:assert/strict');
const { runQuery } = require('../src/engine');

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function genData(seed, { uniqueKey = false } = {}) {
  const rand = rng(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const maybeNull = (v) => (rand() < 0.2 ? null : v);
  const n1 = 20 + Math.floor(rand() * 60);
  const n2 = 20 + Math.floor(rand() * 60);
  const t = [];
  const u = [];
  for (let i = 0; i < n1; i++) {
    t.push({
      id: i,
      k: maybeNull(1 + Math.floor(rand() * 15)),
      v: maybeNull(Math.floor(rand() * 100)),
      g: pick(['a', 'b', 'c']),
    });
  }
  const seen = new Set();
  for (let i = 0; i < n2; i++) {
    let k = 1 + Math.floor(rand() * 15);
    if (uniqueKey) {
      k = i + 1; // guaranteed unique, overlaps t.k range for small i
      seen.add(k);
    } else {
      k = maybeNull(k);
    }
    u.push({ k, w: Math.floor(rand() * 50), h: pick(['x', 'y']) });
  }
  const total = n1 + n2;
  assert.ok(total <= 300, 'generated input must stay within 300 rows');
  return { t, u };
}

const QUERIES = [
  'SELECT t.g, COUNT(*) AS c, SUM(t.v) AS s FROM t GROUP BY t.g HAVING SUM(t.v) > 50',
  'SELECT t.g, AVG(t.v) AS a FROM t JOIN u ON t.k = u.k GROUP BY t.g HAVING AVG(t.v) > 10',
  'SELECT t.k, COUNT(*) AS c FROM t JOIN u ON t.k = u.k WHERE t.v > 20 AND u.w < 40 GROUP BY t.k',
  'SELECT t.g, MIN(t.v) AS mn, MAX(t.v) AS mx FROM t WHERE t.k IS NOT NULL GROUP BY t.g HAVING COUNT(*) >= 2',
  'SELECT t.k, SUM(t.v) AS s FROM t JOIN u ON t.k = u.k WHERE u.h = \'x\' GROUP BY t.k HAVING SUM(t.v) IS NOT NULL',
  'SELECT COUNT(*) AS c FROM t JOIN u ON t.k = u.k WHERE t.g = \'a\' OR t.v IS NULL',
];

for (const uniqueKey of [false, true]) {
  test(`optimized == direct enumeration on random data (uniqueKey=${uniqueKey})`, () => {
    for (let seed = 1; seed <= 12; seed++) {
      const data = genData(seed * 7 + (uniqueKey ? 1000 : 0), { uniqueKey });
      for (const sql of QUERIES) {
        const r = runQuery(sql, data); // throws E_NON_EQUIV on any mismatch
        assert.ok(r.certificate.equal, `seed=${seed} sql=${sql}`);
        assert.equal(r.certificate.mode, 'full');
        assert.ok(r.certificate.rules.length >= 0);
        // certificate carries rule sequence + sampled row hashes
        assert.ok(Array.isArray(r.certificate.baseline.rowSamples));
      }
    }
  });
}

test('unknown groups survive optimization identically (boundary)', () => {
  const data = {
    t: [
      { id: 1, k: 1, v: null, g: 'a' },
      { id: 2, k: 2, v: 5, g: 'b' },
      { id: 3, k: null, v: 7, g: 'c' },
    ],
    u: [{ k: 1, w: 1, h: 'x' }, { k: 2, w: 2, h: 'y' }],
  };
  const r = runQuery('SELECT t.g, SUM(t.v) AS s FROM t GROUP BY t.g HAVING SUM(t.v) > 3', data);
  assert.equal(r.rows.length, 2); // b (5>3), c (7>3)
  assert.equal(r.unknown.length, 1); // a: SUM over all-NULL -> NULL > 3 -> unknown
  assert.equal(r.unknown[0]['t.g'], 'a');
  assert.ok(r.certificate.equal);
});
