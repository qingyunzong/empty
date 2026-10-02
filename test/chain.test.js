import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';

function build() {
  const ledger = new Ledger();
  for (let i = 1; i <= 5; i++) {
    ledger.addVoucher({ id: `v${i}`, postings: [{ account: 'cash', amount: String(i), currency: 'BASE' }] });
  }
  return ledger;
}

test('broken chain link is located and recovery restores the clean root', () => {
  const clean = build();

  // Middle-link corruption: detected at the exact position.
  const t1 = build();
  t1.chainLinks[2] = '0'.repeat(64);
  assert.equal(t1.verifyChain(), 2);
  const recovered1 = t1.recover();
  assert.equal(recovered1.brokenAt, 2);
  assert.equal(recovered1.root, clean.root());
  assert.equal(t1.verifyChain(), -1);

  // Tip corruption: root diverges, recovery restores it.
  const t2 = build();
  t2.chainLinks[4] = '0'.repeat(64);
  assert.equal(t2.verifyChain(), 4);
  assert.notEqual(t2.root(), clean.root());
  assert.equal(t2.recover().root, clean.root());
});

test('tampered voucher payload in serialized state reports CHAIN_BROKEN', () => {
  const ledger = build();
  const state = ledger.serialize();
  state.vouchers[1].postings[0].amount = '999';
  assert.throws(() => Ledger.fromState(state), (err) => err.code === 'CHAIN_BROKEN');
});

test('serialized state round-trips to an identical root', () => {
  const ledger = new Ledger({ base: 'CNY' });
  ledger.addSnapshot('fx', { USD: '7.1' });
  ledger.addVoucher({ id: 'v1', lamport: 1, postings: [{ account: 'cash', amount: '100', currency: 'CNY' }] });
  ledger.addVoucher({ id: 'v2', lamport: 2, snapshot: 'fx', postings: [{ account: 'cash', amount: '10', currency: 'USD' }] });
  ledger.reverse({ id: 'r1', target: 'v1' });
  const restored = Ledger.fromState(ledger.serialize());
  assert.equal(restored.root(), ledger.root());
  assert.deepEqual(restored.balances(), ledger.balances());
  assert.deepEqual([...restored.invalidated], [...ledger.invalidated]);
});
