import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, LedgerError, hashInstruction } from '../src/ledger.js';

const I1 = { id: 'i1', payer: 'A', payee: 'B', amount: 100 };
const I2 = { id: 'i2', payer: 'B', payee: 'C', amount: 40 };
const I3 = { id: 'i3', payer: 'C', payee: 'A', amount: 25 };

function ledgerWith(...instructions) {
  const ledger = new Ledger();
  for (const instruction of instructions) ledger.instruct(instruction);
  return ledger;
}

test('three-party instructions produce correct net positions and certificate', () => {
  const ledger = ledgerWith(I1, I2, I3);
  ledger.setBudget({ party: 'A', budget: 100 });
  ledger.setBudget({ party: 'B', budget: 100 });
  ledger.setBudget({ party: 'C', budget: 100 });

  assert.deepEqual(ledger.net(), { A: 75, B: -60, C: -15 });

  const certificate = ledger.settle();
  assert.equal(certificate.status, 'settled');
  assert.deepEqual(
    certificate.instructions.map((i) => i.id),
    ['i1', 'i2', 'i3'],
  );
  assert.deepEqual(certificate.net, { A: 75, B: -60, C: -15 });
  assert.deepEqual(certificate.budgets, {
    A: { budget: 100, net: 75, ok: true },
    B: { budget: 100, net: -60, ok: true },
    C: { budget: 100, net: -15, ok: true },
  });
  const total = Object.values(certificate.net).reduce((sum, v) => sum + v, 0);
  assert.equal(total, 0);
});

test('cancelling the over-limit instruction makes the batch settleable', () => {
  const ledger = ledgerWith(I1, I2, I3);
  ledger.setBudget({ party: 'A', budget: 50 });

  assert.equal(ledger.certificate().status, 'blocked');
  assert.throws(() => ledger.settle(), (error) => {
    assert.equal(error.code, 'budget-exceeded');
    return true;
  });

  const hash = hashInstruction(I1);
  const tombstone = ledger.cancel({ id: 'i1', hash });
  assert.deepEqual(tombstone, { type: 'cancel', id: 'i1', hash });

  assert.deepEqual(ledger.net(), { A: -25, B: 40, C: -15 });
  const certificate = ledger.settle();
  assert.equal(certificate.status, 'settled');
  assert.deepEqual(
    certificate.instructions.map((i) => i.id),
    ['i2', 'i3'],
  );
  assert.equal(certificate.budgets.A.ok, true);
});

test('budget-exceeded, idempotent cancel, and unknown-instruction errors', () => {
  const ledger = ledgerWith(I1);
  ledger.setBudget({ party: 'A', budget: 10 });

  assert.throws(() => ledger.settle(), (error) => {
    assert.ok(error instanceof LedgerError);
    assert.equal(error.code, 'budget-exceeded');
    return true;
  });

  const first = ledger.cancel({ id: 'i1' });
  const second = ledger.cancel({ id: 'i1' });
  assert.deepEqual(second, first, 'repeated cancel is idempotent');
  assert.deepEqual(ledger.net(), {});
  assert.equal(ledger.settle().status, 'settled');

  assert.throws(() => ledger.cancel({ id: 'nope' }), (error) => {
    assert.equal(error.code, 'unknown-instruction');
    return true;
  });
});

test('cancel with mismatched observed hash is rejected', () => {
  const ledger = ledgerWith(I1);
  assert.throws(() => ledger.cancel({ id: 'i1', hash: 'deadbeef' }), (error) => {
    assert.equal(error.code, 'hash-mismatch');
    return true;
  });
});

test('merge applies events incrementally and dedupes concurrent cancels', () => {
  const replicaA = ledgerWith(I1, I2);
  const replicaB = ledgerWith(I1, I2);

  const tombstoneA = replicaA.cancel({ id: 'i1' });
  const tombstoneB = replicaB.cancel({ id: 'i1' });
  assert.deepEqual(tombstoneA, tombstoneB, 'concurrent cancels produce the same tombstone');

  replicaA.merge([{ type: 'instruct', ...I3 }, tombstoneB]);
  replicaB.merge([{ type: 'instruct', ...I3 }, tombstoneA]);

  assert.deepEqual(replicaA.net(), replicaB.net());
  assert.deepEqual(replicaA.toJSON(), replicaB.toJSON());
  assert.deepEqual(replicaA.net(), { A: -25, B: 40, C: -15 });

  assert.throws(() => replicaA.merge([{ type: 'cancel', id: 'ghost' }]), (error) => {
    assert.equal(error.code, 'unknown-instruction');
    return true;
  });
});

test('duplicate instruction redelivery is idempotent, conflict is rejected', () => {
  const ledger = ledgerWith(I1);
  assert.doesNotThrow(() => ledger.instruct(I1));
  assert.throws(() => ledger.instruct({ ...I1, amount: 101 }), (error) => {
    assert.equal(error.code, 'conflicting-instruction');
    return true;
  });
});

test('state round-trips through JSON', () => {
  const ledger = ledgerWith(I1, I2, I3);
  ledger.setBudget({ party: 'A', budget: 50 });
  ledger.cancel({ id: 'i2' });

  const restored = Ledger.fromJSON(JSON.parse(JSON.stringify(ledger)));
  assert.deepEqual(restored.toJSON(), ledger.toJSON());
  assert.deepEqual(restored.certificate(), ledger.certificate());
});

test('enumeration: every cancel subset of three instructions matches independent summation', () => {
  const instructions = [
    { id: 'p1', payer: 'A', payee: 'B', amount: 30 },
    { id: 'p2', payer: 'B', payee: 'C', amount: 20 },
    { id: 'p3', payer: 'C', payee: 'A', amount: 10 },
  ];
  const budgets = { A: 25, B: 15, C: 5 };

  function independentNet(cancelled) {
    const net = {};
    for (const instruction of instructions) {
      if (cancelled.has(instruction.id)) continue;
      net[instruction.payer] = (net[instruction.payer] ?? 0) + instruction.amount;
      net[instruction.payee] = (net[instruction.payee] ?? 0) - instruction.amount;
    }
    return Object.fromEntries(
      Object.entries(net).sort(([a], [b]) => (a < b ? -1 : 1)),
    );
  }

  function independentCertificate(cancelled) {
    const net = independentNet(cancelled);
    const active = instructions.filter((i) => !cancelled.has(i.id)).map((i) => i.id);
    const parties = new Set([...Object.keys(net), ...Object.keys(budgets)]);
    let blocked = false;
    for (const party of parties) {
      const payable = net[party] ?? 0;
      if (payable > budgets[party]) blocked = true;
    }
    return { net, active, status: blocked ? 'blocked' : 'settled' };
  }

  const subsets = 1 << instructions.length;
  for (let mask = 0; mask < subsets; mask += 1) {
    const cancelled = new Set(
      instructions.filter((_, index) => mask & (1 << index)).map((i) => i.id),
    );

    const ledger = new Ledger({ budgets });
    for (const instruction of instructions) ledger.instruct(instruction);
    for (const id of cancelled) ledger.cancel({ id });

    const expected = independentCertificate(cancelled);
    const certificate = ledger.certificate();

    assert.deepEqual(ledger.net(), expected.net, `net mismatch for mask ${mask}`);
    assert.deepEqual(
      certificate.instructions.map((i) => i.id),
      expected.active,
      `active set mismatch for mask ${mask}`,
    );
    assert.equal(certificate.status, expected.status, `status mismatch for mask ${mask}`);

    if (expected.status === 'settled') {
      assert.equal(ledger.settle().status, 'settled');
    } else {
      assert.throws(() => ledger.settle(), (error) => error.code === 'budget-exceeded');
    }
  }
});
