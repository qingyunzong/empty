'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyOps } = require('../src/migrate');
const { verifyMigration } = require('../src/verify');
const { EXIT } = require('../src/errors');

const oldSet = [
  { id: 'a', account: 'alice', debit: 10, credit: 4, freeze: 2, state: 'PENDING', currency: 'USD' },
  { id: 'c', account: 'bob', debit: 7, credit: 7, freeze: 5, state: 'SETTLED', currency: 'USD' },
];

function migrated() {
  return applyOps(oldSet, [
    { op: 'split', id: 'a', parts: [
      { id: 'a1', debit: 6, credit: 4, freeze: 0 },
      { id: 'a2', debit: 4, credit: 0, freeze: 2 },
    ] },
    { op: 'restate', id: 'a2', fields: { freeze: 3 } },
  ]);
}

test('honest migration verifies OK', () => {
  const { instructions, proof } = migrated();
  const result = verifyMigration(oldSet, instructions, proof);
  assert.equal(result.ok, true);
  assert.equal(result.failure, null);
});

test('tampered perAccountDelta fails conservation first with exit 25', () => {
  const { instructions, proof } = migrated();
  const forged = JSON.parse(JSON.stringify(proof));
  forged.perAccountDelta.alice.net = 999;
  const result = verifyMigration(oldSet, instructions, forged);
  assert.equal(result.ok, false);
  assert.equal(result.failure.invariant, 'conservation');
  assert.equal(result.failure.code, EXIT.CONSERVATION);
  assert.equal(result.failure.account, 'alice');
});

test('tampered new.json (amount drift) fails conservation and locates account', () => {
  const { instructions, proof } = migrated();
  const tampered = JSON.parse(JSON.stringify(instructions));
  tampered.find((i) => i.id === 'a1').debit += 1;
  const result = verifyMigration(oldSet, tampered, proof);
  assert.equal(result.ok, false);
  assert.equal(result.failure.invariant, 'conservation');
  assert.equal(result.failure.account, 'alice');
});

test('tampered SETTLED amounts fail settledProtection with exit 26', () => {
  const { instructions, proof } = migrated();
  const tampered = JSON.parse(JSON.stringify(instructions));
  const settled = tampered.find((i) => i.id === 'c');
  settled.debit += 1;
  settled.credit += 1; // keep conservation intact so settledProtection is the first failure
  const result = verifyMigration(oldSet, tampered, proof);
  assert.equal(result.ok, false);
  assert.equal(result.failure.invariant, 'settledProtection');
  assert.equal(result.failure.code, EXIT.SETTLED_AMOUNT);
  assert.equal(result.failure.account, 'bob');
});

test('forged proof with non-empty forbiddenOps fails forbiddenOps invariant', () => {
  const { instructions, proof } = migrated();
  const forged = JSON.parse(JSON.stringify(proof));
  forged.forbiddenOps = [{ op: 'restate', id: 'c', fields: { debit: 99 } }];
  const result = verifyMigration(oldSet, instructions, forged);
  assert.equal(result.ok, false);
  assert.equal(result.failure.invariant, 'forbiddenOps');
  assert.equal(result.failure.code, EXIT.GENERIC);
});

test('structurally broken proof fails schema invariant', () => {
  const { instructions } = migrated();
  const result = verifyMigration(oldSet, instructions, { version: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.failure.invariant, 'schema');
});

test('first failing invariant is reported when several are broken', () => {
  const { instructions, proof } = migrated();
  const tampered = JSON.parse(JSON.stringify(instructions));
  const settled = tampered.find((i) => i.id === 'c');
  settled.debit += 5; // breaks conservation AND settledProtection
  const forged = JSON.parse(JSON.stringify(proof));
  forged.forbiddenOps = [{ op: 'restate', id: 'c' }];
  const result = verifyMigration(oldSet, tampered, forged);
  assert.equal(result.ok, false);
  assert.equal(result.failure.invariant, 'conservation');
});
