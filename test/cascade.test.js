// Acceptance 1: backfill insertion in the middle triggers invalidation cascade.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';
import { verifyProof } from '../src/hash.js';

function buildLedger(withBackfill) {
  const ledger = new Ledger();
  for (let i = 1; i <= 5; i++) {
    ledger.addVoucher({
      id: `v${i}`,
      entries: [{ account: 'cash', amount: 10 * i }, { account: 'rev', amount: -10 * i }],
      deps: i > 1 ? [`v${i - 1}`] : [],
    });
  }
  if (withBackfill) {
    ledger.addVoucher({ id: 'bx', entries: [{ account: 'cash', amount: 7 }, { account: 'rev', amount: -7 }], pos: 3.5 });
  }
  return ledger;
}

test('mid-insertion invalidates downstream vouchers and recomputes balances', () => {
  const before = buildLedger(false);
  assert.equal(before.balances.get('cash'), 150);
  assert.deepEqual(before.invalidIds(), []);

  const after = buildLedger(true);
  // v4 and v5 were built on v3's state; bx now sits between v3 and v4.
  assert.deepEqual(after.invalidIds(), ['v4', 'v5']);
  assert.equal(after.balances.get('cash'), 10 + 20 + 30 + 7);
  assert.equal(after.balances.get('rev'), -(10 + 20 + 30 + 7));
  assert.notEqual(after.root, before.root);
});

test('recompute is deterministic: same op log yields same root', () => {
  const a = buildLedger(true);
  const b = new Ledger();
  for (const line of a.serialize().split('\n').filter(Boolean)) {
    const entry = JSON.parse(line);
    if (entry.op === 'snapshot') b.addSnapshot(entry.params);
    else if (entry.op === 'voucher') b.addVoucher(entry.params);
    else if (entry.op === 'reverse') b.reverse(entry.params);
  }
  assert.equal(b.root, a.root);
  assert.equal(b.chainTip, a.chainTip);
  assert.deepEqual(b.invalidIds(), a.invalidIds());
});

test('invalidated vouchers stay in the chain log (no silent rewrite of history)', () => {
  const ledger = buildLedger(true);
  assert.equal(ledger.chain.length, 6);
  assert.ok(ledger.vouchers.get('v4').invalid);
  assert.ok(ledger.vouchers.get('v5').invalid);
  const proof = ledger.proof('bx');
  assert.equal(proof.valid, true);
  assert.ok(verifyProof(proof.leaf, proof.proof, proof.root));
  assert.equal(ledger.proof('v4').valid, false);
});

test('re-entering corrected vouchers appends new records and converges', () => {
  const ledger = buildLedger(true);
  ledger.addVoucher({ id: 'v4b', entries: [{ account: 'cash', amount: 40 }, { account: 'rev', amount: -40 }], deps: ['bx'] });
  ledger.addVoucher({ id: 'v5b', entries: [{ account: 'cash', amount: 50 }, { account: 'rev', amount: -50 }], deps: ['v4b'] });
  assert.deepEqual(ledger.invalidIds(), ['v4', 'v5']);
  assert.equal(ledger.balances.get('cash'), 10 + 20 + 30 + 7 + 40 + 50);
  assert.equal(ledger.validRecords().length, 6);
});
