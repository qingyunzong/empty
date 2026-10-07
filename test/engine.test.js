'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');
const { verifyCertificate, feasiblePoint } = require('../src/lp');

// Invoice: amount >= 10000 (cents), tax >= 1300, tax exactly 13% of amount.
// A full red-flush credit adds the exact dual (negated) constraints,
// pinning the system to the original invoice point with zero tolerance.
function invoiceCmd() {
  return {
    cmd: 'invoice',
    id: 'inv-1',
    vars: ['amount', 'tax'],
    constraints: [
      { coefs: [1, 0], op: '>=', rhsNum: 10000, rhsDen: 1 },
      { coefs: [0, 1], op: '>=', rhsNum: 1300, rhsDen: 1 },
      { coefs: [-13, 100], op: '==', rhsNum: 0, rhsDen: 1 },
    ],
  };
}

function fullCreditCmd(id) {
  return {
    cmd: 'credit',
    id,
    refId: 'inv-1',
    constraints: [
      { coefs: [1, 0], op: '<=', rhsNum: 10000, rhsDen: 1 },
      { coefs: [0, 1], op: '<=', rhsNum: 1300, rhsDen: 1 },
      { coefs: [-13, 100], op: '==', rhsNum: 0, rhsDen: 1 },
    ],
  };
}

test('acceptance 1: full red-flush cancels dually and is SAT at the invoice vertex', () => {
  const e = new Engine();
  assert.equal(e.exec(invoiceCmd()).status, 'OK');
  assert.equal(e.exec(fullCreditCmd('cr-1')).status, 'OK');
  const res = e.exec({ cmd: 'check', invoiceId: 'inv-1' });
  assert.equal(res.status, 'SAT');
  assert.equal(res.vertex.amount, '10000');
  assert.equal(res.vertex.tax, '1300');
});

test('acceptance 2: credit one cent short is UNSAT with a verifiable certificate', () => {
  const e = new Engine();
  e.exec(invoiceCmd());
  const short = fullCreditCmd('cr-short');
  short.constraints[0] = { coefs: [1, 0], op: '<=', rhsNum: 9999, rhsDen: 1 }; // one cent short
  e.exec(short);
  const res = e.exec({ cmd: 'check', invoiceId: 'inv-1' });
  assert.equal(res.status, 'UNSAT');
  assert.equal(res.error, 'E_UNSAT');
  // the reported violated set must be an irreducible infeasible subset
  const got = e.gatherConstraints('inv-1');
  const iis = got.all.filter((c) => res.violated.includes(c.id));
  assert.equal(iis.length, res.violated.length);
  assert.equal(feasiblePoint(iis, got.inv.dim).sat, false);
  for (const drop of res.violated) {
    const rest = iis.filter((c) => c.id !== drop);
    assert.equal(feasiblePoint(rest, got.inv.dim).sat, true, `dropping ${drop} stays UNSAT`);
  }
  // the certificate pins the short credit
  assert.ok(res.violated.some((id) => id.startsWith('cr-short#')));
  // certificate verifies exactly against the IIS constraints
  assert.equal(verifyCertificate(iis, got.inv.dim, res.certificate.multipliers), true);
  // engine-level re-verification against the live pool
  assert.equal(e.verify('inv-1', res.certificate).ok, true);
});

test('acceptance 3: voiding a certificate-referenced credit is E_PINNED', () => {
  const e = new Engine();
  e.exec(invoiceCmd());
  const short = fullCreditCmd('cr-pinned');
  short.constraints[0] = { coefs: [1, 0], op: '<=', rhsNum: 9999, rhsDen: 1 };
  e.exec(short);
  assert.equal(e.exec({ cmd: 'check', invoiceId: 'inv-1' }).status, 'UNSAT');
  const denied = e.exec({ cmd: 'voidCredit', id: 'cr-pinned' });
  assert.equal(denied.error, 'E_PINNED');
  // credit is still active: the system is still UNSAT
  assert.equal(e.exec({ cmd: 'check', invoiceId: 'inv-1' }).status, 'UNSAT');
});

test('voiding an unreferenced credit restores the original invoice', () => {
  const e = new Engine();
  e.exec(invoiceCmd());
  const short = fullCreditCmd('cr-temp');
  short.constraints[0] = { coefs: [1, 0], op: '<=', rhsNum: 9999, rhsDen: 1 };
  e.exec(short);
  // no check ran yet -> nothing pinned
  const ok = e.exec({ cmd: 'voidCredit', id: 'cr-temp' });
  assert.equal(ok.status, 'OK');
  assert.equal(ok.restored, 'inv-1');
  const res = e.exec({ cmd: 'check', invoiceId: 'inv-1' });
  assert.equal(res.status, 'SAT');
});

test('E_REF for unknown references', () => {
  const e = new Engine();
  assert.equal(e.exec({ cmd: 'check', invoiceId: 'nope' }).error, 'E_REF');
  assert.equal(e.exec({ cmd: 'credit', refId: 'nope', constraints: [] }).error, 'E_REF');
  assert.equal(e.exec({ cmd: 'voidCredit', id: 'nope' }).error, 'E_REF');
});

test('E_DIM: N > 3 is the only source of UNDECIDED', () => {
  const e = new Engine();
  const big = e.exec({
    cmd: 'invoice',
    id: 'inv-4d',
    vars: ['a', 'b', 'c', 'd'],
    constraints: [{ coefs: [1, 0, 0, 0], op: '<=', rhsNum: 1, rhsDen: 1 }],
  });
  assert.equal(big.status, 'OK');
  const res = e.exec({ cmd: 'check', invoiceId: 'inv-4d' });
  assert.equal(res.status, 'UNDECIDED');
  assert.equal(res.error, 'E_DIM');
  // coefs length mismatch is rejected at registration
  const bad = e.exec({
    cmd: 'invoice',
    id: 'inv-bad',
    vars: ['a', 'b'],
    constraints: [{ coefs: [1, 1, 1], op: '<=', rhsNum: 1, rhsDen: 1 }],
  });
  assert.equal(bad.error, 'E_DIM');
});

test('equality boundary is inclusive', () => {
  const e = new Engine();
  e.exec({
    cmd: 'invoice',
    id: 'inv-eq',
    vars: ['x'],
    constraints: [{ coefs: [1], op: '==', rhsNum: 7, rhsDen: 2 }],
  });
  const res = e.exec({ cmd: 'check', invoiceId: 'inv-eq' });
  assert.equal(res.status, 'SAT');
  assert.equal(res.vertex.x, '7/2');
});
