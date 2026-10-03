import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditService } from '../src/service.js';
import { verifyCert } from '../src/cert.js';

test('batch import issues a chained, verifiable certificate', () => {
  const svc = new AuditService();
  const r1 = svc.importBatch({ source: 'valid', intervals: [[0, 5], [5, 9]] });
  const r2 = svc.importBatch({ source: 'frozen', intervals: [[2, 3]] });
  assert.equal(r1.status, 'COMMITTED');
  assert.equal(svc.certs.length, 2);
  assert.equal(svc.certs[1].body.prevId, svc.certs[0].id);
  assert.equal(typeof r1.cert.body.inputDigest, 'string');
  assert.equal(r1.cert.body.ops[0].op, 'import');
  assert.equal(typeof r1.cert.body.outputHash, 'string');
  assert.equal(r2.cert.body.prevId, r1.cert.id);
  assert.equal(svc.verify(), true);
});

test('acceptance 3: tampering one endpoint is detected by the certificate', () => {
  const svc = new AuditService();
  svc.importBatch({ source: 'valid', intervals: [[0, 5], [10, 20]] });
  assert.equal(svc.verify(), true);
  // flip a single endpoint in the stored output
  svc.certs[0].output.valid[1][1] = 21;
  assert.throws(() => svc.verify(), { code: 'E_CERT' });
  // also detected when the body itself is edited
  const svc2 = new AuditService();
  svc2.importBatch({ source: 'valid', intervals: [[0, 5]] });
  svc2.certs[0].body.ops[0].intervals[0][1] = 6;
  assert.throws(() => verifyCert(svc2.certs[0]), { code: 'E_CERT' });
});

test('acceptance 2: revoking a patch restores the holes', () => {
  const svc = new AuditService();
  svc.importBatch({ source: 'valid', intervals: [[0, 5], [9, 20]] });
  assert.deepEqual(svc.report([0, 20]).gaps, [[5, 9]]);

  // correction patch fills the hole
  const { patch, cert } = svc.applyPatch({ reason: 'late-arriving evidence', add: [[5, 9]] });
  assert.deepEqual(svc.state.valid, [[0, 20]]);
  assert.deepEqual(svc.report([0, 20]).gaps, []);
  // new cert proves old cert's invalidation reason and its own coverage
  assert.equal(cert.body.cause.type, 'correction');
  assert.equal(cert.body.cause.invalidates, svc.certs[0].id);
  assert.equal(cert.body.cause.reason, 'late-arriving evidence');
  assert.equal(svc.verify(), true);

  // revocation restores the hole exactly
  const { restored } = svc.revokePatch(patch.id);
  assert.deepEqual(restored, [[0, 5], [9, 20]]);
  assert.deepEqual(svc.report([0, 20]).gaps, [[5, 9]]);
  assert.equal(svc.verify(), true);
  assert.equal(svc.patches[0].revoked, true);
});

test('patch errors raise E_PATCH', () => {
  const svc = new AuditService();
  assert.throws(() => svc.applyPatch({ reason: 'x', add: [[0, 1]] }), { code: 'E_PATCH' });
  svc.importBatch({ source: 'valid', intervals: [[0, 10]] });
  assert.throws(() => svc.applyPatch({ add: [[0, 1]] }), { code: 'E_PATCH' }); // no reason
  assert.throws(() => svc.applyPatch({ reason: 'noop' }), { code: 'E_PATCH' }); // empty
  assert.throws(
    () => svc.applyPatch({ reason: 'noop', subtract: [[50, 60]] }),
    { code: 'E_PATCH' },
  ); // unchanged state
  assert.throws(
    () => svc.applyPatch({ reason: 'stale', add: [[0, 1]], targetCertId: 'deadbeef' }),
    { code: 'E_PATCH' },
  );
  assert.throws(() => svc.revokePatch('nope'), { code: 'E_PATCH' });
});

test('unknown source is PENDING, not unsatisfiable; strict mode raises E_UNKNOWN', () => {
  const svc = new AuditService();
  const { status } = svc.importBatch({ source: 'telegram-rumor', intervals: [[3, 7]] });
  assert.equal(status, 'PENDING');
  assert.equal(svc.query(4).status, 'PENDING');
  assert.equal(svc.query(40).status, 'UNSATISFIED');
  // PENDING evidence still counts as coverage for gap reporting
  assert.deepEqual(svc.report([0, 10]).coverageGaps, [[0, 3], [7, 10]]);
  assert.throws(
    () => svc.importBatch({ source: 'mystery', intervals: [[0, 1]] }, { strict: true }),
    { code: 'E_UNKNOWN' },
  );
});

test('point query priority: frozen > exempt > valid > pending', () => {
  const svc = new AuditService();
  svc.importBatch({ source: 'valid', intervals: [[0, 100]] });
  svc.importBatch({ source: 'exempt', intervals: [[10, 20]] });
  svc.importBatch({ source: 'frozen', intervals: [[15, 18]] });
  svc.importBatch({ source: 'unknown-wire', intervals: [[200, 300]] });
  assert.equal(svc.query(16).status, 'FROZEN');
  assert.equal(svc.query(12).status, 'EXEMPT');
  assert.equal(svc.query(50).status, 'VALID');
  assert.equal(svc.query(250).status, 'PENDING');
  assert.equal(svc.query(500).status, 'UNSATISFIED');
});

test('state round-trips through JSON', () => {
  const svc = new AuditService();
  svc.importBatch({ source: 'valid', intervals: [[0, 5]] });
  svc.applyPatch({ reason: 'fix', add: [[5, 9]] });
  const clone = AuditService.fromJSON(JSON.parse(JSON.stringify(svc.toJSON())));
  assert.deepEqual(clone.state, svc.state);
  assert.equal(clone.verify(), true);
});
