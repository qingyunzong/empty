'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');
const { computeAllStatuses } = require('../src/full');
const { canonicalize } = require('../src/canon');
const {
  mulberry32,
  randomInstance,
  randomCorrections,
  applyToPlain,
  deepCopy,
} = require('./helpers');

// Acceptance 1: for random DAGs with n <= 10, the incremental engine must
// agree with the independent recursive full recomputation, including after
// corrections are applied.
test('incremental engine matches independent recursive full recompute on random DAGs', () => {
  for (let seed = 1; seed <= 60; seed += 1) {
    const rand = mulberry32(seed);
    const instance = randomInstance(rand);
    const plain = deepCopy(instance);

    const engine = new Engine(deepCopy(instance));
    assert.deepEqual(engine.errors, [], `seed ${seed}: unexpected structural errors`);
    engine.computeAll();
    engine.issueCertificates();

    const corrections = randomCorrections(rand, plain);
    for (const corr of corrections) {
      const err = engine.applyCorrection(corr);
      assert.equal(err, null, `seed ${seed}: correction rejected: ${JSON.stringify(corr)}`);
      applyToPlain(plain, corr);
    }

    const reference = computeAllStatuses(plain.lots, plain.edges, plain.tests);
    for (const lot of plain.lots) {
      const actual = engine.state.get(lot.id);
      const expected = reference.get(lot.id);
      assert.equal(actual.status, expected.status, `seed ${seed}: status mismatch on ${lot.id}`);
      assert.deepEqual(actual.contaminatedBy, expected.contaminatedBy, `seed ${seed}: contamination mismatch on ${lot.id}`);
    }

    // Certificate bases of finished goods must match a basis rebuilt from
    // the reference results.
    for (const lot of plain.lots.filter((l) => l.type === 'finished_good')) {
      const cert = engine.certs.get(lot.id);
      const refBasis = {
        lot: lot.id,
        status: reference.get(lot.id).status,
        failing_tests: reference.get(lot.id).contaminatedBy,
        inputs: plain.edges
          .filter((e) => e.to === lot.id)
          .map((e) => [e.from, reference.get(e.from).status])
          .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
      };
      assert.equal(canonicalize(cert.basis), canonicalize(refBasis), `seed ${seed}: cert basis mismatch on ${lot.id}`);
    }
  }
});

test('incremental recompute touches only the downstream cone', () => {
  for (let seed = 101; seed <= 130; seed += 1) {
    const rand = mulberry32(seed);
    const instance = randomInstance(rand);
    if (instance.tests.length === 0) continue;
    const engine = new Engine(deepCopy(instance));
    assert.deepEqual(engine.errors, []);
    engine.computeAll();
    engine.issueCertificates();
    const target = instance.tests[0];
    const err = engine.applyCorrection({ type: 'revoke_test', test_id: target.id });
    assert.equal(err, null);
    const closure = engine._downstreamClosure(target.lot);
    assert.equal(engine.stats.lotsRecomputed, closure.size);
    assert.ok(engine.stats.lotsRecomputed <= instance.lots.length);
  }
});
