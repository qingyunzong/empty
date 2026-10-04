import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateLine, buildCertificate, normalizeConfig } from '../src/index.js';
import { REFERENCE_CONFIG } from '../test-shared/fixtures.js';

test('SAFE result carries a finite-horizon coverage certificate', () => {
  const r = simulateLine(REFERENCE_CONFIG);
  assert.equal(r.status, 'SAFE');
  const cert = r.certificate;
  assert.ok(cert, 'SAFE must carry a certificate');
  assert.equal(cert.covered, true);
  assert.equal(cert.violations.length, 0);
  assert.ok(Number.isFinite(cert.horizon));
  assert.ok(cert.statesExplored >= 1);
  assert.ok(cert.transitions >= 1);
  assert.match(cert.digest, /^[0-9a-f]{64}$/);
  // Certificate accounts for every buffer's peak occupancy within capacity.
  cert.maxOccupancy.forEach((occ, i) => {
    assert.ok(occ <= REFERENCE_CONFIG.buffers[i].cap);
  });
});

test('certificate exploration covers dequeue tie-break alternatives', () => {
  // Buffer 0 holds items [3,4] at t=4, so the certificate explores both
  // dequeue orders; it must visit strictly more states than the 8 timestamps
  // of the deterministic trajectory.
  const cert = buildCertificate(normalizeConfig(REFERENCE_CONFIG));
  assert.ok(cert.statesExplored > 8, `expected branching exploration, got ${cert.statesExplored} states`);
});

test('certificate digest is deterministic', () => {
  const a = buildCertificate(normalizeConfig(REFERENCE_CONFIG));
  const b = buildCertificate(normalizeConfig(REFERENCE_CONFIG));
  assert.equal(a.digest, b.digest);
  assert.equal(a.statesExplored, b.statesExplored);
});

test('UNKNOWN is never reported as SAFE when the state budget is exhausted', () => {
  const r = simulateLine({ ...REFERENCE_CONFIG, stateBudget: 1 });
  assert.equal(r.status, 'UNKNOWN');
  assert.equal(r.certificate.covered, false);
  assert.notEqual(r.status, 'SAFE');
});

test('events beyond the horizon make the result UNKNOWN, not SAFE', () => {
  const r = simulateLine({ ...REFERENCE_CONFIG, horizon: 2 });
  assert.equal(r.status, 'UNKNOWN');
  assert.equal(r.certificate.covered, false);
});
