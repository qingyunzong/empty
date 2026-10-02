'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runSample, AuditError } = require('../src/index');
const { baseRequest } = require('./helpers');

test('quota boundary: quota equal to population draws everything', () => {
  const request = baseRequest({ strata: [{ id: 'retail', quota: 5 }, { id: 'wholesale', quota: 4 }] });
  const { output } = runSample(request, null);
  for (const sample of output.samples) {
    assert.equal(sample.records.length, sample.populationSize);
  }
});

test('quota boundary: quota zero draws nothing but still certifies', () => {
  const request = baseRequest({ strata: [{ id: 'retail', quota: 0 }, { id: 'wholesale', quota: 0 }] });
  const { output } = runSample(request, null);
  for (const sample of output.samples) {
    assert.equal(sample.records.length, 0);
  }
  assert.equal(typeof output.merkleRoot, 'string');
});

test('quota exceeding population fails with QUOTA', () => {
  const request = baseRequest({ strata: [{ id: 'retail', quota: 6 }, { id: 'wholesale', quota: 2 }] });
  assert.throws(() => runSample(request, null), (err) => {
    assert.ok(err instanceof AuditError);
    assert.equal(err.code, 'QUOTA');
    assert.equal(err.details.stratum, 'retail');
    assert.equal(err.details.quota, 6);
    assert.equal(err.details.population, 5);
    return true;
  });
});

test('compute budget boundary: exact budget passes, one less fails', () => {
  const exact = baseRequest({ computeBudget: 9 }); // 5 + 4 records hashed
  const { output } = runSample(exact, null);
  assert.equal(output.quotaUse.hashEvaluations, 9);
  assert.equal(output.quotaUse.computeBudget, 9);

  const over = baseRequest({ computeBudget: 8 });
  assert.throws(() => runSample(over, null), (err) => {
    assert.equal(err.code, 'QUOTA');
    assert.equal(err.details.hashEvaluations, 9);
    assert.equal(err.details.computeBudget, 8);
    return true;
  });
});

test('quotaUse reports per-stratum quota, population and drawn counts', () => {
  const { output } = runSample(baseRequest(), null);
  assert.deepEqual(output.quotaUse.perStratum, {
    retail: { quota: 2, population: 5, drawn: 2 },
    wholesale: { quota: 2, population: 4, drawn: 2 },
  });
});
