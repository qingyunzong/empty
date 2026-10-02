'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyOps } = require('../src/migrate');
const { verifyMigration } = require('../src/verify');
const { MigrateError, EXIT } = require('../src/errors');

const base = [
  { id: 'a', account: 'alice', debit: 10, credit: 4, freeze: 2, state: 'PENDING', currency: 'USD' },
  { id: 'b', account: 'alice', debit: 3, credit: 1, freeze: 0, state: 'PENDING', currency: 'USD' },
  { id: 'c', account: 'bob', debit: 7, credit: 7, freeze: 5, state: 'SETTLED', currency: 'USD' },
];

function byId(instructions) {
  return new Map(instructions.map((i) => [i.id, i]));
}

test('split conserves per-account totals and inherits fields', () => {
  const { instructions, proof } = applyOps(base, [
    { op: 'split', id: 'a', parts: [
      { id: 'a1', debit: 6, credit: 4, freeze: 2 },
      { id: 'a2', debit: 4, credit: 0, freeze: 0 },
    ] },
  ]);
  const table = byId(instructions);
  assert.equal(table.has('a'), false);
  assert.equal(table.get('a1').account, 'alice');
  assert.equal(table.get('a1').currency, 'USD');
  assert.equal(table.get('a2').state, 'PENDING');
  assert.deepEqual(proof.perAccountDelta, {});
  assert.deepEqual(proof.forbiddenOps, []);
  assert.equal(proof.conservation.ok, true);
  assert.deepEqual(proof.conservation.accounts, ['alice']);
  assert.equal(verifyMigration(base, instructions, proof).ok, true);
});

test('split conservation failure names the account and exits 25', () => {
  assert.throws(
    () => applyOps(base, [
      { op: 'split', id: 'a', parts: [
        { id: 'a1', debit: 6, credit: 4, freeze: 2 },
        { id: 'a2', debit: 3, credit: 0, freeze: 0 },
      ] },
    ]),
    (err) => {
      assert.ok(err instanceof MigrateError);
      assert.equal(err.code, EXIT.CONSERVATION);
      assert.match(err.message, /account=alice/);
      return true;
    }
  );
});

test('split part targeting another account is a conservation failure (25)', () => {
  assert.throws(
    () => applyOps(base, [
      { op: 'split', id: 'a', parts: [
        { id: 'a1', debit: 10, credit: 4, freeze: 2, account: 'bob' },
        { id: 'a2', debit: 0, credit: 0, freeze: 0 },
      ] },
    ]),
    (err) => err.code === EXIT.CONSERVATION && /account=alice/.test(err.message)
  );
});

test('merge sums amounts for same account and currency', () => {
  const { instructions, proof } = applyOps(base, [
    { op: 'merge', ids: ['a', 'b'], newId: 'ab' },
  ]);
  const table = byId(instructions);
  const merged = table.get('ab');
  assert.deepEqual(
    { debit: merged.debit, credit: merged.credit, freeze: merged.freeze },
    { debit: 13, credit: 5, freeze: 2 }
  );
  assert.equal(merged.state, 'PENDING');
  assert.equal(verifyMigration(base, instructions, proof).ok, true);
});

test('merge across accounts exits 27', () => {
  assert.throws(
    () => applyOps(base, [{ op: 'merge', ids: ['a', 'c'], newId: 'ac' }]),
    (err) => err.code === EXIT.MERGE_CROSS_ACCOUNT && /alice/.test(err.message) && /bob/.test(err.message)
  );
});

test('merge across currencies exits 27', () => {
  const set = [
    { id: 'x', account: 'alice', debit: 1, credit: 0, freeze: 0, state: 'PENDING', currency: 'USD' },
    { id: 'y', account: 'alice', debit: 2, credit: 0, freeze: 0, state: 'PENDING', currency: 'EUR' },
  ];
  assert.throws(
    () => applyOps(set, [{ op: 'merge', ids: ['x', 'y'], newId: 'xy' }]),
    (err) => err.code === EXIT.MERGE_CROSS_ACCOUNT && /currenc/.test(err.message)
  );
});

test('restate on SETTLED may only change memo; amount change exits 26', () => {
  const ok = applyOps(base, [{ op: 'restate', id: 'c', fields: { memo: 'reg-filing-7' } }]);
  assert.equal(byId(ok.instructions).get('c').memo, 'reg-filing-7');
  assert.equal(verifyMigration(base, ok.instructions, ok.proof).ok, true);

  for (const fields of [{ debit: 8 }, { credit: 6 }, { freeze: 4 }, { state: 'PENDING' }]) {
    assert.throws(
      () => applyOps(base, [{ op: 'restate', id: 'c', fields }]),
      (err) => err.code === EXIT.SETTLED_AMOUNT && /SETTLED/.test(err.message) && /c/.test(err.message)
    );
  }
});

test('restate on non-settled changes amounts and records perAccountDelta', () => {
  const { instructions, proof } = applyOps(base, [
    { op: 'restate', id: 'a', fields: { debit: 12, freeze: 5 } },
  ]);
  assert.deepEqual(proof.perAccountDelta, { alice: { net: 2, freeze: 3 } });
  assert.equal(verifyMigration(base, instructions, proof).ok, true);
});

test('combined split + merge + restate sequence stays verifiable', () => {
  const ops = [
    { op: 'split', id: 'a', parts: [
      { id: 'a1', debit: 4, credit: 1, freeze: 1 },
      { id: 'a2', debit: 6, credit: 3, freeze: 1 },
    ] },
    { op: 'merge', ids: ['a1', 'b'], newId: 'ab' },
    { op: 'restate', id: 'a2', fields: { debit: 9, memo: 'adjusted' } },
    { op: 'restate', id: 'c', fields: { memo: 'untouched amounts' } },
  ];
  const { instructions, proof } = applyOps(base, ops);
  const table = byId(instructions);
  assert.deepEqual(
    (({ debit, credit, freeze }) => ({ debit, credit, freeze }))(table.get('ab')),
    { debit: 7, credit: 2, freeze: 1 }
  );
  assert.equal(table.get('a2').debit, 9);
  assert.deepEqual(proof.perAccountDelta, { alice: { net: 3, freeze: 0 } });
  const result = verifyMigration(base, instructions, proof);
  assert.equal(result.ok, true, result.failure && result.failure.message);
});

test('unknown op and missing instruction are usage errors (exit 2)', () => {
  assert.throws(() => applyOps(base, [{ op: 'teleport', id: 'a' }]), (err) => err.code === EXIT.USAGE);
  assert.throws(
    () => applyOps(base, [{ op: 'split', id: 'zzz', parts: [{ id: 'p' }, { id: 'q' }] }]),
    (err) => err.code === EXIT.USAGE
  );
  assert.throws(() => applyOps(base, [{ op: 'merge', ids: ['a', 'zzz'], newId: 'm' }]), (err) => err.code === EXIT.USAGE);
  assert.throws(() => applyOps(base, [{ op: 'restate', id: 'zzz', fields: {} }]), (err) => err.code === EXIT.USAGE);
});
