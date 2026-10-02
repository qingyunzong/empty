'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Lab } = require('../src/lab.js');
const { AT, baseLab } = require('../testkit/fixtures.js');

test('add_artifact validates kind, duplicates and required fields', () => {
  const lab = new Lab();
  assert.throws(() => lab.addArtifact({ kind: 'standard' }), /id is required/);
  assert.throws(() => lab.addArtifact({ id: 'X', kind: 'weird' }), /unknown artifact kind/);
  assert.throws(
    () => lab.addArtifact({ id: 'S', kind: 'standard', rangeClass: 'R1', envClass: 'E1' }),
    /positive numeric uncertainty/,
  );
  assert.throws(
    () => lab.addArtifact({ id: 'S', kind: 'standard', rangeClass: 'R1', envClass: 'E1', uncertainty: 0.01 }),
    /validFrom\/validTo/,
  );
  lab.addArtifact({ id: 'S', kind: 'standard', root: true, rangeClass: 'R1', envClass: 'E1', uncertainty: 0.01 });
  assert.throws(
    () => lab.addArtifact({ id: 'S', kind: 'standard', root: true, rangeClass: 'R1', envClass: 'E1', uncertainty: 0.01 }),
    (e) => e.code === 'DUPLICATE',
  );
  assert.throws(
    () => lab.addArtifact({ id: 'P', kind: 'point', uutId: 'NOPE', rangeClass: 'R1', envClass: 'E1', budget: 1 }),
    /existing uutId/,
  );
});

test('link validates endpoints and duplicates', () => {
  const lab = baseLab();
  assert.throws(() => lab.link('U1', 'NOPE'), (e) => e.code === 'NOT_FOUND');
  assert.throws(() => lab.link('U1', 'S1'), (e) => e.code === 'DUPLICATE');
  assert.throws(() => lab.link('U1', 'U1'), (e) => e.code === 'INVALID');
  assert.throws(() => lab.link('P1', 'S1'), (e) => e.code === 'INVALID_KIND');
  assert.throws(() => lab.link('S1', 'U1'), (e) => e.code === 'INVALID_KIND');
});

test('unlink is blocked while measurements are pending, allowed after certify', () => {
  const lab = baseLab();
  assert.throws(() => lab.unlink('S1', 'ROOT'), (e) => {
    assert.equal(e.code, 'UNLINK_BLOCKED');
    assert.deepEqual(e.details.pending, ['M-1']);
    return true;
  });
  assert.throws(() => lab.unlink('U1', 'S1'), (e) => e.code === 'UNLINK_BLOCKED');
  const r = lab.certify('P1', AT);
  assert.equal(r.status, 'CERT');
  const removed = lab.unlink('S1', 'ROOT');
  assert.deepEqual(removed, { from: 'S1', to: 'ROOT' });
  assert.throws(() => lab.unlink('S1', 'ROOT'), (e) => e.code === 'NOT_FOUND');
});

test('reserve/release are paired; violations raise LEASE_STATE', () => {
  const lab = baseLab();
  assert.throws(() => lab.release('S1', 'job-1'), (e) => e.code === 'LEASE_STATE');
  lab.reserve('S1', 'job-1');
  assert.throws(() => lab.reserve('S1', 'job-2'), (e) => e.code === 'LEASE_STATE');
  assert.throws(() => lab.release('S1', 'job-2'), (e) => e.code === 'LEASE_STATE');
  const out = lab.release('S1', 'job-1');
  assert.deepEqual(out, { released: 'S1', holder: 'job-1' });
  lab.reserve('S1', 'job-2'); // free again after paired release
  assert.throws(() => lab.reserve('U1', 'job-3'), (e) => e.code === 'INVALID_KIND');
  assert.throws(() => lab.reserve('NOPE', 'job-3'), (e) => e.code === 'NOT_FOUND');
});

test('measure requires an existing point and a numeric value', () => {
  const lab = baseLab();
  assert.throws(() => lab.measure({ pointId: 'NOPE', value: 1 }), (e) => e.code === 'NO_SUCH_POINT');
  assert.throws(() => lab.measure({ pointId: 'P1' }), (e) => e.code === 'INVALID');
  const m = lab.measure({ pointId: 'P1', value: 9.999, temp: 20, humidity: 40 });
  assert.equal(m.id, 'M-2');
  assert.equal(m.uMeas, 0);
});
