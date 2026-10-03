import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInstance } from '../src/schema.mjs';
import { solveNormalized } from '../src/solver.mjs';
import { buildUnsatCertificate, verifyUnsatCertificate } from '../src/certificate.mjs';
import { fixture12 } from '../testlib/fixtures.mjs';

const unsatFixture = {
  jobs: [
    { id: 'a', due: 10, work: 2, energy: 10, mold: 'M' },
    { id: 'b', due: 20, work: 3, energy: 10, mold: 'M' },
    { id: 'c', due: 30, work: 1, energy: 10, mold: 'M' },
  ],
  setup: { M: {} },
  energyBudget: 25, // min possible energy is 30 -> UNSAT
};

test('over energy budget returns UNSAT with a re-verifiable minimal certificate', () => {
  const v = normalizeInstance(unsatFixture);
  assert.equal(v.ok, true, v.error);
  const res = solveNormalized(v.instance);
  assert.equal(res.status, 'UNSAT');
  assert.equal(res.minEnergy, 30);

  const cert = buildUnsatCertificate(v.instance);
  assert.deepEqual([...cert.jobs].sort(), ['a', 'b', 'c']);
  assert.equal(cert.minEnergy, 30);
  // Minimal core: removing any single job drops minEnergy to 20 <= 25.
  assert.equal(cert.removals.length, 3);
  for (const r of cert.removals) assert.equal(r.minEnergy, 20);

  const verdict = verifyUnsatCertificate(v.instance, cert);
  assert.equal(verdict.valid, true, JSON.stringify(verdict.checks));
  assert.ok(/^[0-9a-f]{64}$/.test(cert.enumHash));
});

test('certificate verification rejects tampering', () => {
  const v = normalizeInstance(unsatFixture);
  const cert = buildUnsatCertificate(v.instance);

  const badHash = { ...cert, enumHash: cert.enumHash.replace(/^./, cert.enumHash[0] === '0' ? '1' : '0') };
  assert.equal(verifyUnsatCertificate(v.instance, badHash).valid, false);

  // Budget 30 makes the core feasible (minEnergy 30 <= 30): claim breaks.
  const badBudget = { ...cert, budget: 30 };
  assert.equal(verifyUnsatCertificate(v.instance, badBudget).valid, false);

  const badRemoval = { ...cert, removals: cert.removals.map((r, i) => (i === 0 ? { ...r, minEnergy: 19 } : r)) };
  assert.equal(verifyUnsatCertificate(v.instance, badRemoval).valid, false);

  // Certificate is bound to its instance: verifying against another instance fails.
  const other = normalizeInstance({ ...unsatFixture, energyBudget: 26 });
  assert.equal(verifyUnsatCertificate(other.instance, cert).valid, false);
});

test('UNKNOWN is never reported as UNSAT', () => {
  const v = normalizeInstance(fixture12);
  const res = solveNormalized(v.instance, { nodeLimit: 1 });
  assert.equal(res.status, 'UNKNOWN');
  assert.notEqual(res.status, 'UNSAT');
  assert.match(res.reason, /node limit/);
});
