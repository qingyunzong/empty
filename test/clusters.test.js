'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FactoringStore, tokenize } = require('../src/store.js');

// --- Independent reference implementation (no library code reused) ---

// Enumerate every word-pair window by hand: for each i < j with
// (j - i - 1) <= slop, record the ordered pair.
function referenceWindows(memo, slop) {
  const words = memo.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const keys = new Set();
  for (let i = 0; i < words.length; i++) {
    for (let j = i + 1; j < words.length; j++) {
      if (j - i - 1 > slop) break;
      keys.add(words[i] + ' ' + words[j]);
    }
  }
  return keys;
}

function referenceClusters(invoices, slop) {
  const active = invoices.filter((i) => i.state === 'active');
  const windows = new Map(active.map((i) => [i.id, referenceWindows(i.memo, slop)]));
  const parent = new Map(active.map((i) => [i.id, i.id]));
  const find = (x) => (parent.get(x) === x ? x : parent.set(x, find(parent.get(x))).get(x));
  for (let a = 0; a < active.length; a++) {
    for (let b = a + 1; b < active.length; b++) {
      if (active[a].creditor !== active[b].creditor) continue;
      const wa = windows.get(active[a].id);
      const wb = windows.get(active[b].id);
      let hit = false;
      for (const k of wa) if (wb.has(k)) { hit = true; break; }
      if (hit) parent.set(find(active[a].id), find(active[b].id));
    }
  }
  const groups = new Map();
  for (const inv of active) {
    const root = find(inv.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(inv.id);
  }
  return [...groups.values()]
    .filter((m) => m.length >= 2)
    .map((m) => m.slice().sort())
    .sort((x, y) => x[0].localeCompare(y[0]));
}

function storeClusters(store) {
  return store
    .clusters()
    .map((c) => c.members.slice().sort())
    .sort((x, y) => x[0].localeCompare(y[0]));
}

function buildStore(slop, invoices) {
  const store = new FactoringStore({ creditLine: 1e12, slop });
  for (const inv of invoices) store.addInvoice(inv);
  return store;
}

const FIXTURE = [
  { id: 'A1', creditor: 'acme', faceValue: 100, advanceRate: 0.5, memo: 'steel delivery contract' },
  { id: 'A2', creditor: 'acme', faceValue: 200, advanceRate: 0.5, memo: 'steel delivery note' },
  { id: 'A3', creditor: 'acme', faceValue: 300, advanceRate: 0.5, memo: 'delivery contract copy' },
  { id: 'A4', creditor: 'acme', faceValue: 400, advanceRate: 0.5, memo: 'totally unrelated words' },
  { id: 'B1', creditor: 'beta', faceValue: 500, advanceRate: 0.5, memo: 'steel delivery contract' },
  { id: 'B2', creditor: 'beta', faceValue: 600, advanceRate: 0.5, memo: 'steel delivery here' },
  { id: 'C1', creditor: 'gamma', faceValue: 700, advanceRate: 0.5, memo: 'alpha beta gamma delta' },
  { id: 'C2', creditor: 'gamma', faceValue: 800, advanceRate: 0.5, memo: 'alpha x beta' },
  { id: 'C3', creditor: 'gamma', faceValue: 900, advanceRate: 0.5, memo: 'alpha x x beta' },
];

for (const slop of [0, 1, 2]) {
  test(`clusters match brute-force word-pair window enumeration (slop=${slop})`, () => {
    const store = buildStore(slop, FIXTURE);
    const expected = referenceClusters(store.listInvoices(), slop);
    assert.deepEqual(storeClusters(store), expected);
  });
}

test('slop boundary: gap exactly equal to slop matches, slop+1 does not', () => {
  // "alpha x beta": pair (alpha,beta) has exactly 1 word in between.
  const near = { id: 'N', creditor: 'c', faceValue: 10, advanceRate: 0.5, memo: 'alpha x beta' };
  const far = { id: 'F', creditor: 'c', faceValue: 10, advanceRate: 0.5, memo: 'alpha x x beta' };
  const base = { id: 'B', creditor: 'c', faceValue: 10, advanceRate: 0.5, memo: 'alpha beta' };

  const s0 = buildStore(0, [base, { ...near }]);
  assert.deepEqual(storeClusters(s0), [], 'slop=0 must not match a gap of 1');

  const s1 = buildStore(1, [base, { ...near }]);
  assert.deepEqual(storeClusters(s1), [['B', 'N']], 'slop=1 matches a gap of exactly 1');

  const s1far = buildStore(1, [base, { ...far }]);
  assert.deepEqual(storeClusters(s1far), [], 'slop=1 must not match a gap of 2');

  const s2far = buildStore(2, [base, { ...far }]);
  assert.deepEqual(storeClusters(s2far), [['B', 'F']], 'slop=2 matches a gap of exactly 2');
});

test('clusters never span creditors even with identical memos', () => {
  const store = buildStore(1, [
    { id: 'X1', creditor: 'one', faceValue: 10, advanceRate: 0.5, memo: 'same memo here' },
    { id: 'X2', creditor: 'two', faceValue: 10, advanceRate: 0.5, memo: 'same memo here' },
  ]);
  assert.deepEqual(storeClusters(store), []);
});

test('transitive association merges into one cluster', () => {
  const store = buildStore(0, [
    { id: 'T1', creditor: 'c', faceValue: 10, advanceRate: 0.5, memo: 'a b' },
    { id: 'T2', creditor: 'c', faceValue: 10, advanceRate: 0.5, memo: 'a b c' },
    { id: 'T3', creditor: 'c', faceValue: 10, advanceRate: 0.5, memo: 'b c' },
  ]);
  assert.deepEqual(storeClusters(store), [['T1', 'T2', 'T3']]);
});

test('tokenize is case-insensitive and punctuation-tolerant', () => {
  assert.deepEqual(tokenize('Hello,  WORLD! foo-bar'), ['hello', 'world', 'foo', 'bar']);
});
