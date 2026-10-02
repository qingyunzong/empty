import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';
import { verifyProof } from '../src/merkle.js';

function buildLedger() {
  const ledger = new Ledger({ base: 'CNY' });
  ledger.addSnapshot('fx-1', { USD: '7.1' });
  ledger.addVoucher({ id: 'v1', lamport: 1, postings: [{ account: 'cash', amount: '100', currency: 'CNY' }] });
  ledger.addVoucher({ id: 'v2', lamport: 2, snapshot: 'fx-1', postings: [{ account: 'cash', amount: '50', currency: 'USD' }] });
  ledger.addVoucher({
    id: 'v3', lamport: 3,
    postings: [
      { account: 'cash', amount: '-20', currency: 'CNY' },
      { account: 'expense', amount: '20', currency: 'CNY' },
    ],
  });
  ledger.addVoucher({ id: 'v4', lamport: 4, postings: [{ account: 'revenue', amount: '5', currency: 'CNY' }] });
  return ledger;
}

test('mid-chain insertion cascades invalidation downstream and matches full recompute', () => {
  const ledger = buildLedger();
  const rootBefore = ledger.root();

  // Backfill v1b with lamport 1: ties with v1, lexicographic order puts it after v1.
  const res = ledger.addVoucher({
    id: 'v1b', lamport: 1,
    postings: [{ account: 'cash', amount: '7', currency: 'CNY' }],
  });

  assert.deepEqual(ledger.order, ['v1', 'v1b', 'v2', 'v3', 'v4']);
  assert.deepEqual(res.invalidated, ['v2', 'v3', 'v4']);
  assert.notEqual(ledger.root(), rootBefore);

  // Differentially maintained balances: cash = 100 + 7 + 50*7.1 - 20 = 442
  assert.equal(ledger.balances().cash, '442');
  assert.equal(ledger.balances().expense, '20');
  assert.equal(ledger.balances().revenue, '5');

  // Differential maintenance must equal deterministic full recomputation.
  assert.equal(ledger.fullRecompute(), ledger.root());

  // Proof paths verify for every voucher, including the inserted one.
  for (const id of ledger.order) {
    const proof = ledger.proof(id);
    assert.ok(verifyProof(proof.leaf, proof.path, proof.merkleRoot), `proof for ${id}`);
  }
});

test('reversal is append-only, marks invalidation range, never rewrites history', () => {
  const ledger = buildLedger();
  const hashesBefore = new Map([...ledger.vouchers].map(([id, r]) => [id, r.hash]));

  const res = ledger.reverse({ id: 'r1', target: 'v2' });

  // Old vouchers untouched.
  for (const [id, hash] of hashesBefore) {
    assert.equal(ledger.vouchers.get(id).hash, hash, `${id} hash must not change`);
  }
  // v3 shares account cash with v2 -> invalidated; v4 (revenue only) is not.
  assert.deepEqual(res.invalidated, ['v3']);
  assert.deepEqual([...ledger.invalidated].sort(), ['v3']);
  assert.deepEqual([...ledger.reversed], ['v2']);
  // Reversal appended at the end with a fresh lamport clock value.
  assert.equal(ledger.order.at(-1), 'r1');
  // Balances: cash = 100 + 355 - 20 - 355 = 80
  assert.equal(ledger.balances().cash, '80');
  assert.equal(ledger.fullRecompute(), ledger.root());

  assert.throws(() => ledger.reverse({ id: 'r2', target: 'v2' }), /already reversed/);
  assert.throws(() => ledger.reverse({ id: 'r3', target: 'r1' }), /cannot reverse a reversal/);
});
