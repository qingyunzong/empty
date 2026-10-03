// Acceptance 3: randomized small ledgers cross-checked against an independent
// brute-force reference implementation (full replay from genesis, no checkpoints).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';
import { verifyProof } from '../src/hash.js';
import { ReferenceLedger, mulberry32 } from '../testlib/reference.js';

const ACCOUNTS = ['cash', 'ar', 'rev'];

function randomOps(rng, count) {
  const ops = [];
  const voucherIds = [];
  const reversedTargets = new Set();
  let snapshotCount = 0;
  let voucherCount = 0;
  for (let i = 0; i < count; i++) {
    const roll = rng();
    if (roll < 0.1 || (snapshotCount === 0 && i === 0)) {
      snapshotCount += 1;
      ops.push({ op: 'snapshot', id: `fx${snapshotCount}`, pair: 'USD/CNY', rate: 1 + Math.floor(rng() * 3) });
    } else if (roll < 0.85 || voucherIds.length === 0) {
      voucherCount += 1;
      const id = `v${voucherCount}`;
      const entryCount = 1 + Math.floor(rng() * 2);
      const entries = [];
      for (let e = 0; e < entryCount; e++) {
        const entry = {
          account: ACCOUNTS[Math.floor(rng() * ACCOUNTS.length)],
          amount: Math.floor(rng() * 41) - 20,
        };
        if (snapshotCount > 0 && rng() < 0.25) {
          entry.currency = 'USD';
          entry.snapshot = `fx${1 + Math.floor(rng() * snapshotCount)}`;
        }
        entries.push(entry);
      }
      const deps = [];
      for (const vid of voucherIds) {
        if (rng() < 0.25) deps.push(vid);
      }
      const op = { op: 'voucher', id, entries, deps };
      if (rng() < 0.3 && voucherIds.length > 0) {
        op.pos = Math.floor(rng() * (voucherCount + 2) * 2) / 2;
      }
      ops.push(op);
      voucherIds.push(id);
    } else {
      const candidates = voucherIds.filter((id) => !reversedTargets.has(id));
      if (candidates.length === 0) continue;
      const target = candidates[Math.floor(rng() * candidates.length)];
      reversedTargets.add(target);
      ops.push({ op: 'reverse', id: `r${target}`, target });
    }
  }
  return ops;
}

function applyBoth(ops, seedLabel) {
  const ledger = new Ledger();
  const reference = new ReferenceLedger();
  for (const [index, op] of ops.entries()) {
    const ctx = `${seedLabel} op#${index} ${JSON.stringify(op)}`;
    if (op.op === 'snapshot') {
      ledger.addSnapshot(op);
      reference.addSnapshot(op);
    } else if (op.op === 'voucher') {
      ledger.addVoucher(op);
      reference.addVoucher(op);
    } else {
      ledger.reverse(op);
      reference.reverse(op);
    }
    const expected = reference.state();
    assert.equal(ledger.root, expected.root, `root mismatch: ${ctx}`);
    assert.deepEqual(ledger.invalidIds(), expected.invalidIds, `invalid set mismatch: ${ctx}`);
    assert.deepEqual(
      Object.fromEntries([...ledger.balances.entries()].sort()),
      Object.fromEntries([...expected.balances.entries()].sort()),
      `balances mismatch: ${ctx}`,
    );
  }
  return { ledger, reference };
}

for (const seed of [1, 7, 42, 1337]) {
  test(`random ledger (seed ${seed}) matches brute-force reference`, () => {
    const rng = mulberry32(seed);
    const ops = randomOps(rng, 60);
    const { ledger, reference } = applyBoth(ops, `seed=${seed}`);
    const expected = reference.state();
    for (const record of ledger.validRecords()) {
      const proof = ledger.proof(record.id);
      assert.ok(verifyProof(proof.leaf, proof.proof, expected.root), `proof failed for ${record.id}`);
    }
  });
}

test('missing snapshots and dependencies raise the same codes in both implementations', () => {
  const ledger = new Ledger();
  const reference = new ReferenceLedger();
  const badVoucher = { id: 'x', entries: [{ account: 'cash', amount: 1, currency: 'USD', snapshot: 'ghost' }] };
  assert.throws(() => ledger.addVoucher(badVoucher), (e) => e.code === 'MISSING_SNAPSHOT');
  assert.throws(() => reference.addVoucher(badVoucher), (e) => e.code === 'MISSING_SNAPSHOT');
  const badDep = { id: 'y', entries: [{ account: 'cash', amount: 1 }], deps: ['ghost'] };
  assert.throws(() => ledger.addVoucher(badDep), (e) => e.code === 'MISSING_DEPENDENCY');
  assert.throws(() => reference.addVoucher(badDep), (e) => e.code === 'MISSING_DEPENDENCY');
});
