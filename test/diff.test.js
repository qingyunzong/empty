'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyDiff, DIFF_KINDS } = require('../src/diff');
const { CODES } = require('../src/errors');

const base = { id: 't1', accountId: 'a1', day: '2026-10-04', amount: 100, currency: 'CNY', status: 'settled' };
const entry = (over = {}) => ({ ...base, ...over });

test('classifies each diff kind', () => {
  assert.equal(classifyDiff([entry()], [entry()]).length, 0);
  assert.equal(classifyDiff([entry()], [])[0].kind, DIFF_KINDS.MISSING_IN_SNAPSHOT);
  assert.equal(classifyDiff([], [entry()])[0].kind, DIFF_KINDS.MISSING_IN_LEDGER);
  assert.equal(classifyDiff([entry()], [entry({ amount: 5 })])[0].kind, DIFF_KINDS.AMOUNT_MISMATCH);
  assert.equal(classifyDiff([entry()], [entry({ currency: 'USD' })])[0].kind, DIFF_KINDS.CURRENCY_MISMATCH);
  assert.equal(classifyDiff([entry()], [entry({ status: 'pending' })])[0].kind, DIFF_KINDS.STATUS_MISMATCH);
  assert.equal(classifyDiff([entry()], [entry({ accountId: 'a2' })])[0].kind, DIFF_KINDS.ATTRIBUTE_MISMATCH);
});

test('diff output is sorted by id and deterministic', () => {
  const ledger = [entry({ id: 'b' }), entry({ id: 'a', amount: 1 })];
  const snapshot = [entry({ id: 'a', amount: 2 }), entry({ id: 'c' })];
  const diffs = classifyDiff(ledger, snapshot);
  assert.deepEqual(diffs.map((d) => d.id), ['a', 'b', 'c']);
  assert.deepEqual(diffs.map((d) => d.kind), [
    DIFF_KINDS.AMOUNT_MISMATCH, DIFF_KINDS.MISSING_IN_SNAPSHOT, DIFF_KINDS.MISSING_IN_LEDGER,
  ]);
});

test('malformed input raises BAD_DIFF', () => {
  for (const bad of [
    () => classifyDiff('nope', []),
    () => classifyDiff([{ id: 1 }], []),
    () => classifyDiff([entry({ amount: NaN })], []),
    () => classifyDiff([entry({ day: '10/04' })], []),
    () => classifyDiff([entry(), entry()], []), // duplicate id
    () => classifyDiff([], [entry({ currency: 'CN' })]),
  ]) {
    assert.throws(bad, (err) => err.code === CODES.BAD_DIFF);
  }
});

// Straightforward reference classifier, written independently of src/diff.js.
function referenceClassify(ledger, snapshot) {
  const out = [];
  const lIds = ledger.map((e) => e.id);
  const sIds = snapshot.map((e) => e.id);
  for (const e of ledger) {
    const other = snapshot.find((s) => s.id === e.id);
    if (!other) out.push({ id: e.id, kind: 'MISSING_IN_SNAPSHOT' });
    else if (e.amount !== other.amount) out.push({ id: e.id, kind: 'AMOUNT_MISMATCH' });
    else if (e.currency !== other.currency) out.push({ id: e.id, kind: 'CURRENCY_MISMATCH' });
    else if (e.status !== other.status) out.push({ id: e.id, kind: 'STATUS_MISMATCH' });
    else if (e.accountId !== other.accountId || e.day !== other.day) out.push({ id: e.id, kind: 'ATTRIBUTE_MISMATCH' });
  }
  for (const e of snapshot) {
    if (!lIds.includes(e.id)) out.push({ id: e.id, kind: 'MISSING_IN_LEDGER' });
  }
  void sIds;
  return out.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomEntry(rand, id) {
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  return {
    id,
    accountId: pick(['a1', 'a2']),
    day: pick(['2026-10-03', '2026-10-04']),
    amount: pick([0, 1, 100, -50, 3.14]),
    currency: pick(['CNY', 'USD']),
    status: pick(['settled', 'pending']),
  };
}

test('matches reference classifier for all random cases with n<=8', () => {
  const rand = mulberry32(0xC0FFEE);
  for (let iter = 0; iter < 3000; iter += 1) {
    const nL = Math.floor(rand() * 9); // 0..8
    const nS = Math.floor(rand() * 9);
    const idPool = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10'];
    const shuffled = [...idPool].sort(() => rand() - 0.5);
    const ledger = shuffled.slice(0, nL).map((id) => randomEntry(rand, id));
    const snapshot = shuffled.slice(0, nS).map((id) => randomEntry(rand, id));
    const got = classifyDiff(ledger, snapshot).map((d) => ({ id: d.id, kind: d.kind }));
    const want = referenceClassify(ledger, snapshot);
    assert.deepEqual(got, want, `mismatch at iter ${iter}`);
  }
});
