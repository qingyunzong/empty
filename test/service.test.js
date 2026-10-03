import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditService } from '../src/service.js';
import { verifyChain } from '../src/cert.js';

function seeded() {
  const svc = new AuditService();
  svc.importBatch([
    { op: 'add', kind: 'VALID', intervals: [{ start: 0, end: 5 }, { start: 10, end: 15 }] },
    { op: 'add', kind: 'FROZEN', intervals: [{ start: 3, end: 4 }] },
  ]);
  return svc;
}

test('batch import issues a tamper-evident certificate', () => {
  const svc = seeded();
  assert.equal(svc.certs.length, 1);
  const cert = svc.certs[0];
  assert.equal(cert.id, 'cert-0001');
  assert.equal(cert.prevHash, 'GENESIS');
  assert.equal(cert.type, 'import');
  assert.equal(typeof cert.inputDigest, 'string');
  assert.equal(typeof cert.stateHash, 'string');
  assert.equal(cert.ops.length, 2);
  assert.deepEqual(svc.verify().ok, true);
});

test('unknown-source intervals become PENDING, not unsatisfiable', () => {
  const svc = new AuditService();
  svc.importBatch([{ op: 'add', kind: 'some-vendor-feed', intervals: [{ start: 20, end: 30 }] }]);
  assert.deepEqual(svc.getState('PENDING'), [{ start: 20, end: 30 }]);
  assert.equal(svc.queryPoint(25).status, 'PENDING');
  assert.deepEqual(svc.verify().ok, true);
});

test('point query attribution with precedence FROZEN > EXEMPT > VALID > PENDING', () => {
  const svc = seeded();
  assert.equal(svc.queryPoint(3).status, 'FROZEN');
  assert.deepEqual(svc.queryPoint(3).kinds, ['VALID', 'FROZEN']);
  assert.equal(svc.queryPoint(1).status, 'VALID');
  assert.equal(svc.queryPoint(7).status, 'UNCOVERED');
});

test('report finds gaps and cross-kind overlaps', () => {
  const svc = seeded();
  const rep = svc.report(0, 15);
  assert.deepEqual(rep.gaps, [{ start: 5, end: 10 }]);
  assert.deepEqual(rep.overlaps, [
    { kinds: ['VALID', 'FROZEN'], intervals: [{ start: 3, end: 4 }] },
  ]);
  assert.deepEqual(rep.pending, []);
});

test('tampering with one endpoint is detected by the certificate', () => {
  const svc = seeded();
  const certs = svc.exportCerts();

  const tamperedOps = structuredClone(certs);
  tamperedOps[0].ops[0].intervals[0].end += 1; // flip one endpoint 5 -> 6
  assert.throws(() => verifyChain(tamperedOps), (err) => err.code === 'E_CERT');

  const tamperedHash = structuredClone(certs);
  tamperedHash[0].stateHash = '0'.repeat(64);
  assert.throws(() => verifyChain(tamperedHash), (err) => err.code === 'E_CERT');

  const brokenChain = structuredClone(certs);
  brokenChain[0].prevHash = 'deadbeef';
  assert.throws(() => verifyChain(brokenChain), (err) => err.code === 'E_CERT');
});

test('reverse patch invalidates old cert and proves new coverage', () => {
  const svc = seeded();
  const oldCert = svc.certs[svc.certs.length - 1];
  const cert = svc.applyPatch({
    patchId: 'p1',
    reason: 'correction: freeze window mis-registered',
    kind: 'FROZEN',
    remove: [{ start: 3, end: 4 }],
    add: [{ start: 4, end: 5 }],
  });
  assert.equal(cert.type, 'patch');
  assert.equal(cert.supersedes, oldCert.id);
  assert.equal(cert.invalidationReason, 'correction: freeze window mis-registered');
  assert.deepEqual(svc.getState('FROZEN'), [{ start: 4, end: 5 }]);
  assert.deepEqual(svc.verify().ok, true);
});

test('reverting a patch restores the gaps', () => {
  const svc = new AuditService();
  svc.importBatch([{ op: 'add', kind: 'VALID', intervals: [{ start: 0, end: 5 }, { start: 10, end: 15 }] }]);
  assert.deepEqual(svc.report(0, 15).gaps, [{ start: 5, end: 10 }]);

  svc.applyPatch({ patchId: 'fill', reason: 'backfill missing range', kind: 'VALID', add: [{ start: 5, end: 10 }] });
  assert.deepEqual(svc.report(0, 15).gaps, []);

  svc.revertPatch('fill');
  assert.deepEqual(svc.report(0, 15).gaps, [{ start: 5, end: 10 }]);
  assert.deepEqual(svc.verify().ok, true);
});

test('patch error cases raise E_PATCH', () => {
  const svc = seeded();
  assert.throws(() => svc.applyPatch({ kind: 'VALID', add: [{ start: 1, end: 2 }] }), (e) => e.code === 'E_PATCH');
  assert.throws(() => svc.applyPatch({ reason: 'x', kind: 'VALID' }), (e) => e.code === 'E_PATCH');
  assert.throws(() => svc.applyPatch({ reason: 'x', kind: 'VALID', targetCertId: 'cert-9999', add: [{ start: 1, end: 2 }] }), (e) => e.code === 'E_PATCH');
  assert.throws(() => svc.revertPatch('nope'), (e) => e.code === 'E_PATCH');
  svc.applyPatch({ patchId: 'p', reason: 'x', kind: 'VALID', add: [{ start: 30, end: 40 }] });
  svc.revertPatch('p');
  assert.throws(() => svc.revertPatch('p'), (e) => e.code === 'E_PATCH');
});

test('unknown kinds and ops raise E_UNKNOWN', () => {
  const svc = seeded();
  assert.throws(() => svc.getState('BOGUS'), (e) => e.code === 'E_UNKNOWN');
  assert.throws(() => svc.applyPatch({ reason: 'x', kind: 'BOGUS', add: [{ start: 1, end: 2 }] }), (e) => e.code === 'E_UNKNOWN');
  assert.throws(() => svc.importBatch([{ op: 'delete', kind: 'VALID', intervals: [{ start: 1, end: 2 }] }]), (e) => e.code === 'E_UNKNOWN');
});

test('service survives JSON round-trip and still verifies', () => {
  const svc = seeded();
  svc.applyPatch({ patchId: 'p1', reason: 'fix', kind: 'VALID', remove: [{ start: 12, end: 13 }] });
  const restored = AuditService.fromJSON(JSON.parse(JSON.stringify(svc.toJSON())));
  assert.deepEqual(restored.getState(), svc.getState());
  assert.deepEqual(restored.verify().ok, true);
});
