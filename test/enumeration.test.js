'use strict';

// Acceptance test D: enumerate all small ledgers (<= 8 events, 2 accounts,
// 2 currencies) and cross-check three independent implementations:
//   1. the explicit lazy product automaton BFS (src/automaton.js productExplore)
//   2. the proven equivalence criterion (src/automaton.js jointAcceptable)
//   3. a brute-force reference written independently below (refAccept)
// plus end-to-end diffBooks repair scripts validated by applying them.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  diffBooks,
  jointAcceptable,
  productExplore,
  applyScript,
} = require('../index');

// 8 events forming a fully balanced ledger over 2 accounts and 2 currencies.
const POOL = [
  { id: 'e1', account: 'A1', amount: 100, direction: 'debit', currency: 'USD', rel: 'r1' },
  { id: 'e2', account: 'A2', amount: 100, direction: 'credit', currency: 'USD', rel: 'r1' },
  { id: 'e3', account: 'A1', amount: 50, direction: 'debit', currency: 'EUR', rel: 'r2' },
  { id: 'e4', account: 'A2', amount: 50, direction: 'credit', currency: 'EUR', rel: 'r2' },
  { id: 'e5', account: 'A2', amount: 200, direction: 'debit', currency: 'USD', rel: 'r3' },
  { id: 'e6', account: 'A1', amount: 200, direction: 'credit', currency: 'USD', rel: 'r3' },
  { id: 'e7', account: 'A2', amount: 75, direction: 'debit', currency: 'EUR', rel: 'r4' },
  { id: 'e8', account: 'A1', amount: 75, direction: 'credit', currency: 'EUR', rel: 'r4' },
];

// All 2^8 subsets in canonical (pool) order, plus the reversed copy of each.
const LEDGERS = [];
for (let mask = 0; mask < 256; mask += 1) {
  const subset = POOL.filter((_, i) => mask & (1 << i));
  LEDGERS.push(subset);
  LEDGERS.push([...subset].reverse());
}

// Independent brute-force reference: same content multiset, same per-account
// id sequence, and every relation group balanced (zero sum, both directions).
function refAccept(L, R) {
  if (L.length !== R.length) return false;
  const key = (e) => JSON.stringify([e.id, e.account, e.amount, e.direction, e.currency, e.rel]);
  const count = new Map();
  for (const e of L) count.set(key(e), (count.get(key(e)) || 0) + 1);
  for (const e of R) count.set(key(e), (count.get(key(e)) || 0) - 1);
  for (const v of count.values()) if (v !== 0) return false;
  const chains = (arr) => {
    const m = new Map();
    for (const e of arr) {
      if (!m.has(e.account)) m.set(e.account, []);
      m.get(e.account).push(e.id);
    }
    return m;
  };
  const cl = chains(L);
  const cr = chains(R);
  if (cl.size !== cr.size) return false;
  for (const [account, ids] of cl) {
    const o = cr.get(account);
    if (!o || o.length !== ids.length || ids.some((v, i) => v !== o[i])) return false;
  }
  const groups = new Map();
  for (const e of L) {
    if (!groups.has(e.rel)) groups.set(e.rel, []);
    groups.get(e.rel).push(e);
  }
  for (const g of groups.values()) {
    let sum = 0;
    let debits = 0;
    let credits = 0;
    for (const e of g) {
      if (e.direction === 'debit') { sum += e.amount; debits += 1; }
      else { sum -= e.amount; credits += 1; }
    }
    if (sum !== 0 || debits === 0 || credits === 0) return false;
  }
  return true;
}

test('D: product automaton == equivalence criterion == brute-force reference', () => {
  let accepts = 0;
  let checked = 0;
  // All pairs among canonical subsets (256 x 256) ...
  const canonical = LEDGERS.filter((_, i) => i % 2 === 0);
  const pairs = [];
  for (const L of canonical) for (const R of canonical) pairs.push([L, R]);
  // ... plus every canonical subset against its own reversal.
  for (let i = 0; i < canonical.length; i += 1) pairs.push([canonical[i], LEDGERS[i * 2 + 1]]);

  for (const [L, R] of pairs) {
    const expected = refAccept(L, R);
    assert.equal(jointAcceptable(L, R), expected, `jointAcceptable mismatch on ${JSON.stringify([L.map(e=>e.id), R.map(e=>e.id)])}`);
    const prod = productExplore(L, R);
    assert.notEqual(prod.status, 'unknown');
    assert.equal(prod.status === 'accept', expected, `productExplore mismatch on ${JSON.stringify([L.map(e=>e.id), R.map(e=>e.id)])}`);
    if (expected) accepts += 1;
    checked += 1;
  }
  assert.equal(checked, 256 * 256 + 256);
  assert.ok(accepts > 0, 'expected some accepting pairs');
  // Sanity: the full pool against itself accepts; against its reversal rejects
  // (per-account causal order is broken).
  const full = canonical[255];
  const fullRev = LEDGERS[255 * 2 + 1];
  assert.equal(refAccept(full, full), true);
  assert.equal(refAccept(full, fullRev), false);
});

test('D: sampled end-to-end diffBooks repair scripts are valid and minimal', () => {
  const canonical = LEDGERS.filter((_, i) => i % 2 === 0);
  // The 16 balanced subsets (unions of the four relation pairs) give
  // repairable pairs with known minimal costs (2, 4, 6, 8).
  const relPairs = [
    ['e1', 'e2'], ['e3', 'e4'], ['e5', 'e6'], ['e7', 'e8'],
  ];
  const byId = new Map(POOL.map((e) => [e.id, e]));
  const balancedSubsets = [];
  for (let mask = 0; mask < 16; mask += 1) {
    balancedSubsets.push(relPairs.flatMap((pair, i) => (mask & (1 << i) ? pair : [])).map((id) => byId.get(id)));
  }
  const pairs = [];
  for (const L of balancedSubsets) for (const R of balancedSubsets) pairs.push([L, R]);
  for (let i = 0; i < canonical.length; i += 1) {
    for (let j = 0; j < canonical.length; j += 1) {
      if ((i * 256 + j) % 251 === 0) pairs.push([canonical[i], canonical[j]]);
    }
  }
  let sampled = 0;
  let withScripts = 0;
  let searchBound = 0;
  for (const [L, R] of pairs) {
      const expected = refAccept(L, R);
      const res = diffBooks(L, R, { k: 2 });
      sampled += 1;
      assert.equal(res.balanced, expected);
      if (expected) {
        assert.equal(res.certificate.type, 'accept');
        continue;
      }
      if (res.error) {
        assert.equal(res.error.code, 'SEARCH_BOUND');
        assert.ok(res.certificate.provenLowerBound >= 2);
        searchBound += 1;
        continue;
      }
      withScripts += 1;
      assert.ok(res.scripts.length > 0);
      for (const script of res.scripts) {
        assert.ok(script.cost <= 2);
        const [L2, R2] = applyScript(L, R, script.ops);
        assert.ok(jointAcceptable(L2, R2), `script does not repair: ${JSON.stringify(script.ops)}`);
      }
  }
  assert.ok(sampled > 200, `sample too small: ${sampled}`);
  assert.ok(withScripts > 0, 'expected some repairable pairs in the sample');
  assert.ok(searchBound > 0, 'expected some SEARCH_BOUND pairs in the sample');
});
