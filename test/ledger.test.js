import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, LedgerError } from '../src/ledger.js';
import { verifyProof, EMPTY_ROOT } from '../src/hash.js';

test('empty ledger has deterministic empty root', () => {
  const ledger = new Ledger();
  assert.equal(ledger.root, EMPTY_ROOT);
  assert.equal(ledger.validRecords().length, 0);
});

test('append updates balances differentially and root is deterministic', () => {
  const a = new Ledger();
  a.addVoucher({ id: 'v1', entries: [{ account: 'cash', amount: 100 }, { account: 'rev', amount: -100 }] });
  a.addVoucher({ id: 'v2', entries: [{ account: 'cash', amount: 50 }], deps: ['v1'] });
  const b = new Ledger();
  b.addVoucher({ id: 'v1', entries: [{ account: 'cash', amount: 100 }, { account: 'rev', amount: -100 }] });
  b.addVoucher({ id: 'v2', entries: [{ account: 'cash', amount: 50 }], deps: ['v1'] });
  assert.equal(a.root, b.root);
  assert.equal(a.balances.get('cash'), 150);
  assert.equal(a.balances.get('rev'), -100);
});

test('lamport clock: concurrent vouchers ordered by id lexicographically', () => {
  const ledger = new Ledger();
  ledger.addVoucher({ id: 'vb', entries: [{ account: 'b', amount: 1 }] });
  ledger.addVoucher({ id: 'va', entries: [{ account: 'a', amount: 2 }] });
  ledger.addVoucher({ id: 'vc', entries: [{ account: 'a', amount: 4 }], deps: ['va'] });
  const vb = ledger.vouchers.get('vb');
  const va = ledger.vouchers.get('va');
  const vc = ledger.vouchers.get('vc');
  assert.equal(va.lamport, 1);
  assert.equal(vb.lamport, 1);
  assert.equal(vc.lamport, 2);
  assert.deepEqual(ledger.validRecords().map((v) => v.id), ['va', 'vb', 'vc']);
});

test('missing snapshot is reported as MISSING_SNAPSHOT, never as unsatisfiable', () => {
  const ledger = new Ledger();
  assert.throws(
    () => ledger.addVoucher({ id: 'v1', entries: [{ account: 'c', amount: 1, currency: 'USD' }] }),
    (err) => err instanceof LedgerError && err.code === 'MISSING_SNAPSHOT',
  );
  assert.throws(
    () => ledger.addVoucher({ id: 'v1', entries: [{ account: 'c', amount: 1, currency: 'USD', snapshot: 'nope' }] }),
    (err) => err.code === 'MISSING_SNAPSHOT',
  );
});

test('missing dependency is reported as MISSING_DEPENDENCY', () => {
  const ledger = new Ledger();
  assert.throws(
    () => ledger.addVoucher({ id: 'v1', entries: [{ account: 'c', amount: 1 }], deps: ['ghost'] }),
    (err) => err.code === 'MISSING_DEPENDENCY',
  );
});

test('duplicate id, double reversal and snapshot conflict are rejected', () => {
  const ledger = new Ledger();
  ledger.addSnapshot({ id: 'fx', pair: 'USD/CNY', rate: 2 });
  ledger.addVoucher({ id: 'v1', entries: [{ account: 'c', amount: 1 }] });
  assert.throws(() => ledger.addVoucher({ id: 'v1', entries: [{ account: 'c', amount: 2 }] }), (e) => e.code === 'DUPLICATE_ID');
  assert.throws(() => ledger.addSnapshot({ id: 'fx', pair: 'USD/CNY', rate: 3 }), (e) => e.code === 'SNAPSHOT_CONFLICT');
  ledger.reverse({ id: 'r1', target: 'v1' });
  assert.throws(() => ledger.reverse({ id: 'r2', target: 'v1' }), (e) => e.code === 'ALREADY_REVERTED');
  assert.throws(() => ledger.reverse({ id: 'r3', target: 'ghost' }), (e) => e.code === 'MISSING_DEPENDENCY');
});

test('fx entries are converted via snapshot rate', () => {
  const ledger = new Ledger();
  ledger.addSnapshot({ id: 'fx', pair: 'USD/CNY', rate: 2 });
  ledger.addVoucher({ id: 'v1', entries: [{ account: 'cash', amount: 5, currency: 'USD', snapshot: 'fx' }] });
  assert.equal(ledger.balances.get('cash'), 10);
});

test('reversal annuls target and invalidates dependent interval', () => {
  const ledger = new Ledger();
  ledger.addVoucher({ id: 'v1', entries: [{ account: 'cash', amount: 100 }] });
  ledger.addVoucher({ id: 'v2', entries: [{ account: 'cash', amount: 50 }], deps: ['v1'] });
  ledger.reverse({ id: 'r1', target: 'v1' });
  assert.deepEqual(ledger.invalidIds(), ['v2']);
  assert.equal(ledger.balances.get('cash'), 0);
  assert.equal(ledger.vouchers.get('v1').invalid, false);
});

test('proof path verifies against root; invalid voucher has no proof', () => {
  const ledger = new Ledger();
  ledger.addVoucher({ id: 'v1', entries: [{ account: 'c', amount: 1 }] });
  ledger.addVoucher({ id: 'v2', entries: [{ account: 'c', amount: 2 }] });
  ledger.addVoucher({ id: 'v3', entries: [{ account: 'c', amount: 3 }] });
  const proof = ledger.proof('v2');
  assert.equal(proof.valid, true);
  assert.ok(verifyProof(proof.leaf, proof.proof, proof.root));
  ledger.reverse({ id: 'r1', target: 'v1' });
  assert.deepEqual(ledger.invalidIds(), ['v2', 'v3']);
  const gone = ledger.proof('v2');
  assert.equal(gone.valid, false);
  assert.equal(gone.proof, null);
  const kept = ledger.proof('v1');
  assert.equal(kept.valid, true);
  assert.ok(verifyProof(kept.leaf, kept.proof, kept.root));
});
