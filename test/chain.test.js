// Acceptance 2: broken chain detection and recovery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';

function buildLedger() {
  const ledger = new Ledger();
  ledger.addSnapshot({ id: 'fx', pair: 'USD/CNY', rate: 2 });
  ledger.addVoucher({ id: 'v1', entries: [{ account: 'cash', amount: 100 }] });
  ledger.addVoucher({ id: 'v2', entries: [{ account: 'cash', amount: 5, currency: 'USD', snapshot: 'fx' }], deps: ['v1'] });
  ledger.addVoucher({ id: 'v3', entries: [{ account: 'cash', amount: 30 }], deps: ['v2'] });
  return ledger;
}

test('tampered stored hash is detected as BROKEN_CHAIN at the right position', () => {
  const ledger = buildLedger();
  const lines = ledger.serialize().split('\n').filter(Boolean);
  const tampered = lines.map((l) => JSON.parse(l));
  const voucherLines = tampered.filter((l) => l.op === 'voucher');
  voucherLines[1].record.hash = '0'.repeat(64);
  const loaded = Ledger.load(tampered.map((l) => JSON.stringify(l)));
  assert.equal(loaded.chainStatus.ok, false);
  assert.equal(loaded.chainStatus.mismatches.length, 1);
  assert.equal(loaded.chainStatus.mismatches[0].id, 'v2');
});

test('tampered content is detected as well', () => {
  const ledger = buildLedger();
  const lines = ledger.serialize().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const target = lines.find((l) => l.op === 'voucher' && l.params.id === 'v2');
  target.params.entries[0].amount = 999;
  const loaded = Ledger.load(lines.map((l) => JSON.stringify(l)));
  assert.equal(loaded.chainStatus.ok, false);
});

test('recovery rewrites records and restores the original root', () => {
  const ledger = buildLedger();
  const originalRoot = ledger.root;
  const originalTip = ledger.chainTip;
  const lines = ledger.serialize().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const voucherLines = lines.filter((l) => l.op === 'voucher');
  voucherLines[0].record.prevHash = 'f'.repeat(64);
  voucherLines[2].record.hash = 'e'.repeat(64);
  const loaded = Ledger.load(lines.map((l) => JSON.stringify(l)));
  assert.equal(loaded.chainStatus.ok, false);
  assert.equal(loaded.chainStatus.mismatches.length, 2);

  const recovered = Ledger.load(loaded.serialize().split('\n').filter(Boolean));
  assert.equal(recovered.chainStatus.ok, true);
  assert.equal(recovered.root, originalRoot);
  assert.equal(recovered.chainTip, originalTip);
  assert.equal(recovered.balances.get('cash'), 140);
});
