import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';

const OPS = [
  { op: 'snapshot', id: 'fx', rates: { USD: '7.25', EUR: '0.5' } },
  { op: 'voucher', id: 'a', lamport: 1, postings: [{ account: 'cash', amount: '100', currency: 'BASE' }] },
  {
    op: 'voucher', id: 'b', lamport: 2, snapshot: 'fx',
    postings: [
      { account: 'cash', amount: '8', currency: 'USD' },
      { account: 'fee', amount: '2', currency: 'EUR' },
    ],
  },
  {
    op: 'voucher', id: 'c', lamport: 3,
    postings: [
      { account: 'cash', amount: '-30', currency: 'BASE' },
      { account: 'expense', amount: '30', currency: 'BASE' },
    ],
  },
  { op: 'reverse', id: 'rb', lamport: 4, target: 'b' },
];

function applyOp(ledger, op) {
  if (op.op === 'snapshot') ledger.addSnapshot(op.id, op.rates);
  else if (op.op === 'voucher') ledger.addVoucher(op);
  else if (op.op === 'reverse') ledger.reverse(op);
  else throw new Error(`unknown op ${op.op}`);
}

function* permutations(items) {
  if (items.length <= 1) {
    yield items.slice();
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const perm of permutations(rest)) yield [items[i], ...perm];
  }
}

// Independent naive reference: plain Number arithmetic over the canonical order.
function referenceBalances() {
  const rates = { USD: 7.25, EUR: 0.5 };
  const vouchers = [
    { lamport: 1, id: 'a', postings: [{ account: 'cash', amount: 100, currency: 'BASE' }] },
    {
      lamport: 2, id: 'b',
      postings: [
        { account: 'cash', amount: 8, currency: 'USD' },
        { account: 'fee', amount: 2, currency: 'EUR' },
      ],
    },
    {
      lamport: 3, id: 'c',
      postings: [
        { account: 'cash', amount: -30, currency: 'BASE' },
        { account: 'expense', amount: 30, currency: 'BASE' },
      ],
    },
    {
      lamport: 4, id: 'rb',
      postings: [
        { account: 'cash', amount: -8, currency: 'USD' },
        { account: 'fee', amount: -2, currency: 'EUR' },
      ],
    },
  ].sort((x, y) => x.lamport - y.lamport || (x.id < y.id ? -1 : 1));
  const balances = {};
  for (const v of vouchers) {
    for (const p of v.postings) {
      const baseAmount = p.currency === 'BASE' ? p.amount : p.amount * rates[p.currency];
      balances[p.account] = (balances[p.account] ?? 0) + baseAmount;
      if (balances[p.account] === 0) delete balances[p.account];
    }
  }
  return Object.fromEntries(Object.entries(balances).map(([k, v]) => [k, String(v)]));
}

test('brute force: all 120 arrival permutations converge to the same root and balances', () => {
  const roots = new Set();
  const expectedBalances = referenceBalances();
  let count = 0;
  for (const perm of permutations(OPS)) {
    count += 1;
    const ledger = new Ledger();
    for (const op of perm) {
      applyOp(ledger, op);
      // Differential maintenance must always equal full recomputation.
      assert.equal(ledger.fullRecompute(), ledger.root());
    }
    ledger.finalize();
    roots.add(ledger.root());
    assert.deepEqual(ledger.balances(), expectedBalances);
    assert.deepEqual([...ledger.invalidated].sort(), ['c']);
    assert.deepEqual([...ledger.reversed].sort(), ['b']);
    assert.deepEqual(ledger.order, ['a', 'b', 'c', 'rb']);
  }
  assert.equal(count, 120);
  assert.equal(roots.size, 1);
});

test('brute force: every insertion position on a growing chain stays consistent', () => {
  // Insert vouchers 1..6 in every possible relative order via lamport shuffles.
  for (const lamports of permutations([1, 2, 3, 4, 5])) {
    const ledger = new Ledger();
    lamports.forEach((lamport, i) => {
      ledger.addVoucher({
        id: `v${i}`, lamport,
        postings: [{ account: 'cash', amount: String(i + 1), currency: 'BASE' }],
      });
      assert.equal(ledger.fullRecompute(), ledger.root());
    });
    // Canonical order follows the assigned lamports; balances are order-independent here.
    const expectedOrder = lamports
      .map((lamport, i) => ({ lamport, id: `v${i}` }))
      .sort((x, y) => x.lamport - y.lamport)
      .map((e) => e.id);
    assert.deepEqual(ledger.order, expectedOrder);
    assert.equal(ledger.balances().cash, '15');
  }
});
