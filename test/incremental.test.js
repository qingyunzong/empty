'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runSample, verifyCertificate } = require('../src/index');
const { baseRequest } = require('./helpers');

test('identical request reuses certificates and invalidates nothing', () => {
  const request = baseRequest();
  const first = runSample(request, null);
  const second = runSample(request, first.state);
  assert.deepEqual(second.output, first.output);
  assert.deepEqual(second.output.invalidated, []);
});

test('revoking a record re-samples only the affected stratum and keeps invalidation proof', () => {
  const v1 = runSample(baseRequest(), null);
  assert.equal(v1.output.invalidated.length, 0);

  const revokedId = 'tx-retail-0';
  const v2request = baseRequest({ version: 2, revocations: [revokedId] });
  const v2 = runSample(v2request, v1.state);
  const out = v2.output;

  // Only the retail stratum was affected.
  assert.equal(out.invalidated.length, 1);
  const proof = out.invalidated[0];
  assert.equal(proof.stratum, 'retail');
  assert.equal(proof.supersededVersion, 1);
  assert.equal(proof.reason, 'POPULATION_CHANGED');

  // Proof matches the old certificate exactly (old cert invalidated, not deleted).
  const oldRetail = v1.output.samples.find((s) => s.stratum === 'retail');
  assert.equal(proof.stratumRoot, oldRetail.stratumRoot);
  assert.equal(proof.populationHash, oldRetail.populationHash);

  // Old certificate is retained in state history as SUPERSEDED.
  const superseded = v2.state.history.filter((h) => h.status === 'SUPERSEDED');
  assert.equal(superseded.length, 1);
  assert.equal(superseded[0].stratumRoot, oldRetail.stratumRoot);

  // Unaffected stratum keeps its old certificate (sampledAtVersion stays 1).
  const wholesale = out.samples.find((s) => s.stratum === 'wholesale');
  assert.equal(wholesale.sampledAtVersion, 1);
  const oldWholesale = v1.output.samples.find((s) => s.stratum === 'wholesale');
  assert.deepEqual(wholesale.records, oldWholesale.records);

  // New retail sample excludes the revoked record and verifies.
  const retail = out.samples.find((s) => s.stratum === 'retail');
  assert.equal(retail.sampledAtVersion, 2);
  assert.ok(!retail.records.some((r) => r.id === revokedId));
  assert.ok(!retail.population.some((p) => p.id === revokedId));
  assert.equal(retail.populationSize, 4);

  const verification = verifyCertificate(out);
  assert.equal(verification.valid, true, JSON.stringify(verification.checks));
});

test('correcting a record (new version, same id) re-samples only its stratum', () => {
  const v1 = runSample(baseRequest(), null);
  const corrected = baseRequest({
    version: 2,
    ledger: baseRequest().ledger.map((r) =>
      r.id === 'tx-wholesale-1' ? { ...r, version: 2, amount: 777 } : r),
  });
  const v2 = runSample(corrected, v1.state);
  assert.equal(v2.output.invalidated.length, 1);
  assert.equal(v2.output.invalidated[0].stratum, 'wholesale');
  const retail = v2.output.samples.find((s) => s.stratum === 'retail');
  assert.equal(retail.sampledAtVersion, 1);
  assert.equal(verifyCertificate(v2.output).valid, true);
});

test('quota change re-samples only the changed stratum with QUOTA_CHANGED reason', () => {
  const v1 = runSample(baseRequest(), null);
  const v2request = baseRequest({ version: 2, strata: [{ id: 'retail', quota: 3 }, { id: 'wholesale', quota: 2 }] });
  const v2 = runSample(v2request, v1.state);
  assert.equal(v2.output.invalidated.length, 1);
  assert.equal(v2.output.invalidated[0].stratum, 'retail');
  assert.equal(v2.output.invalidated[0].reason, 'QUOTA_CHANGED');
  const retail = v2.output.samples.find((s) => s.stratum === 'retail');
  assert.equal(retail.records.length, 3);
});

test('seed change invalidates all strata', () => {
  const v1 = runSample(baseRequest(), null);
  const v2 = runSample(baseRequest({ version: 2, seed: 'new-seed' }), v1.state);
  assert.equal(v2.output.invalidated.length, 2);
  assert.ok(v2.output.invalidated.every((entry) => entry.reason === 'SEED_CHANGED'));
  assert.equal(verifyCertificate(v2.output).valid, true);
});

test('verify rejects a tampered certificate', () => {
  const { output } = runSample(baseRequest(), null);
  const tampered = JSON.parse(JSON.stringify(output));
  tampered.samples[0].records[0].id = 'tx-forged';
  const result = verifyCertificate(tampered);
  assert.equal(result.valid, false);
});
