'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runSample } = require('../src/index');
const { baseRequest } = require('./helpers');

test('same seed + same version produces identical output', () => {
  const request = baseRequest();
  const first = runSample(request, null).output;
  const second = runSample(request, null).output;
  assert.deepEqual(first, second);
  assert.equal(typeof first.merkleRoot, 'string');
  assert.equal(first.merkleRoot.length, 64);
});

test('ledger record order does not affect the sample (key rotation)', () => {
  const request = baseRequest();
  const shuffled = baseRequest({ ledger: baseRequest().ledger.slice().reverse() });
  const a = runSample(request, null).output;
  const b = runSample(shuffled, null).output;
  assert.deepEqual(a, b);
});

test('different seed produces a different sample with overwhelming probability', () => {
  const a = runSample(baseRequest(), null).output;
  const b = runSample(baseRequest({ seed: 'audit-seed-2' }), null).output;
  assert.notEqual(a.merkleRoot, b.merkleRoot);
});

test('every selected record belongs to its stratum population', () => {
  const { output } = runSample(baseRequest(), null);
  for (const sample of output.samples) {
    const populationIds = new Set(sample.population.map((p) => p.id));
    for (const rec of sample.records) {
      assert.ok(populationIds.has(rec.id));
    }
    assert.equal(sample.records.length, sample.quota);
  }
});
