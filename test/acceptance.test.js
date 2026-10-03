import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, verifyCertificate } from '../src/engine.js';

// Invoice: amount == 100, tax == 13, tax == 13% of amount.
const INVOICE = {
  id: 'INV-1',
  vars: ['amount', 'tax'],
  constraints: [
    { coefs: [1, 0], op: '<=', rhsNum: 100, rhsDen: 1 },
    { coefs: [1, 0], op: '>=', rhsNum: 100, rhsDen: 1 },
    { coefs: [0, 1], op: '<=', rhsNum: 13, rhsDen: 1 },
    { coefs: [0, 1], op: '>=', rhsNum: 13, rhsDen: 1 },
    { coefs: [[-13, 100], 1], op: '<=', rhsNum: 0, rhsDen: 1 },
    { coefs: [[13, 100], -1], op: '<=', rhsNum: 0, rhsDen: 1 },
  ],
};

// Full red-flush: exact dual of every invoice constraint (zero tolerance).
const FULL_CREDIT = [
  { coefs: [1, 0], op: '>=', rhsNum: 100, rhsDen: 1 },
  { coefs: [1, 0], op: '<=', rhsNum: 100, rhsDen: 1 },
  { coefs: [0, 1], op: '>=', rhsNum: 13, rhsDen: 1 },
  { coefs: [0, 1], op: '<=', rhsNum: 13, rhsDen: 1 },
  { coefs: [[-13, 100], 1], op: '>=', rhsNum: 0, rhsDen: 1 },
  { coefs: [[13, 100], -1], op: '>=', rhsNum: 0, rhsDen: 1 },
];

test('acceptance 1: complete red-flush is SAT at the exact boundary point', () => {
  const engine = new Engine();
  engine.invoice(INVOICE);
  engine.credit({ refId: 'INV-1', constraints: FULL_CREDIT });
  const r = engine.check({ invoiceId: 'INV-1' });
  assert.equal(r.status, 'SAT');
  assert.deepEqual(r.witness, { amount: '100', tax: '13' });
  assert.deepEqual(r.vertices, [{ amount: '100', tax: '13' }]);
  assert.equal(r.cancellation.canceled, 6);
  assert.deepEqual(r.cancellation.uncanceled, []);
});

test('acceptance 2: credit short by one cent is UNSAT with a verifiable certificate', () => {
  const engine = new Engine();
  engine.invoice(INVOICE);
  const short = FULL_CREDIT.map((c) => ({ ...c }));
  short[1] = { coefs: [1, 0], op: '<=', rhsNum: 9999, rhsDen: 100 }; // only 99.99 credited
  engine.credit({ refId: 'INV-1', constraints: short });
  const r = engine.check({ invoiceId: 'INV-1' });
  assert.equal(r.status, 'UNSAT');
  assert.equal(r.error, 'E_UNSAT');
  // Every minimal infeasible subset must involve the one-cent-short bound.
  assert.ok(r.iis.some((id) => id.startsWith('C1#c1')));
  assert.ok(r.violated.length >= 1);
  assert.ok(r.violated.every((id) => id.startsWith('INV-1#')));
  assert.equal(verifyCertificate(r.certificate).valid, true);
  assert.equal(engine.verifyCertificate(r.certificate).valid, true);
});

test('acceptance 3: voiding a credit referenced by a check fails with E_PINNED', () => {
  const engine = new Engine();
  engine.invoice(INVOICE);
  engine.credit({ refId: 'INV-1', constraints: FULL_CREDIT }); // -> C1
  engine.check({ invoiceId: 'INV-1' });
  assert.throws(() => engine.voidCredit({ id: 'C1' }), (err) => err.code === 'E_PINNED');
});

test('voidCredit succeeds while no check has referenced the credit', () => {
  const engine = new Engine();
  engine.invoice(INVOICE);
  engine.credit({ refId: 'INV-1', constraints: FULL_CREDIT });
  assert.deepEqual(engine.voidCredit({ id: 'C1' }), { status: 'VOIDED', id: 'C1' });
  const r = engine.check({ invoiceId: 'INV-1' });
  assert.equal(r.status, 'SAT');
  assert.deepEqual(r.credits, []);
});

test('E_REF for unknown invoice, credit reference and void target', () => {
  const engine = new Engine();
  assert.throws(() => engine.credit({ refId: 'NOPE', constraints: [] }), (e) => e.code === 'E_REF');
  assert.throws(() => engine.check({ invoiceId: 'NOPE' }), (e) => e.code === 'E_REF');
  assert.throws(() => engine.voidCredit({ id: 'NOPE' }), (e) => e.code === 'E_REF');
});

test('E_DIM for dimension overflow and coefficient-count mismatch', () => {
  const engine = new Engine();
  assert.throws(
    () => engine.invoice({ id: 'X', vars: ['a', 'b', 'c', 'd'], constraints: [] }),
    (e) => e.code === 'E_DIM',
  );
  engine.invoice({ id: 'Y', vars: ['a', 'b'], constraints: [] });
  assert.throws(
    () => engine.credit({ refId: 'Y', constraints: [{ coefs: [1, 2, 3], op: '<=', rhsNum: 1 }] }),
    (e) => e.code === 'E_DIM',
  );
});

test('SAT vertices are emitted as reduced fractions', () => {
  const engine = new Engine();
  engine.invoice({
    id: 'V',
    vars: ['x', 'y'],
    constraints: [
      { coefs: [1, 2], op: '<=', rhsNum: 1, rhsDen: 1 },
      { coefs: [2, 1], op: '<=', rhsNum: 1, rhsDen: 1 },
      { coefs: [1, 0], op: '>=', rhsNum: 0, rhsDen: 1 },
      { coefs: [0, 1], op: '>=', rhsNum: 0, rhsDen: 1 },
    ],
  });
  const r = engine.check({ invoiceId: 'V' });
  assert.equal(r.status, 'SAT');
  assert.ok(r.vertices.some((v) => v.x === '1/3' && v.y === '1/3'));
  assert.equal(r.vertices.length, 4);
  assert.equal(r.cancellation.canceled, 0); // no credits registered
});

test('3D exact vertex from equality constraints', () => {
  const engine = new Engine();
  engine.invoice({
    id: 'T',
    vars: ['x', 'y', 'z'],
    constraints: [
      { coefs: [1, 0, 0], op: '==', rhsNum: 1, rhsDen: 2 },
      { coefs: [0, 1, 0], op: '==', rhsNum: 1, rhsDen: 3 },
      { coefs: [0, 0, 1], op: '==', rhsNum: 1, rhsDen: 6 },
    ],
  });
  const r = engine.check({ invoiceId: 'T' });
  assert.equal(r.status, 'SAT');
  assert.deepEqual(r.witness, { x: '1/2', y: '1/3', z: '1/6' });
});
