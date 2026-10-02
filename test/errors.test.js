'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runSample, AuditError } = require('../src/index');
const { baseRequest, record } = require('./helpers');

test('missing seed fails with SEED_REQUIRED', () => {
  const request = baseRequest();
  delete request.seed;
  assert.throws(() => runSample(request, null), (err) => {
    assert.ok(err instanceof AuditError);
    assert.equal(err.code, 'SEED_REQUIRED');
    return true;
  });
  assert.throws(() => runSample(baseRequest({ seed: '' }), null), /seed/);
});

test('quota for a stratum absent from the ledger fails with STRATA_MISSING and lists the gap', () => {
  const request = baseRequest({
    strata: [{ id: 'retail', quota: 1 }, { id: 'wholesale', quota: 1 }, { id: 'corporate', quota: 1 }],
  });
  assert.throws(() => runSample(request, null), (err) => {
    assert.equal(err.code, 'STRATA_MISSING');
    assert.ok(err.details.gaps.some((gap) => gap.startsWith('corporate')));
    return true;
  });
});

test('ledger stratum without a declared quota fails with STRATA_MISSING', () => {
  const request = baseRequest({ strata: [{ id: 'retail', quota: 1 }] });
  assert.throws(() => runSample(request, null), (err) => {
    assert.equal(err.code, 'STRATA_MISSING');
    assert.ok(err.details.gaps.some((gap) => gap.startsWith('wholesale')));
    return true;
  });
});

test('missing strata are never silently treated as empty populations', () => {
  const request = baseRequest({
    ledger: [],
    strata: [{ id: 'ghost', quota: 0 }],
  });
  assert.throws(() => runSample(request, null), (err) => {
    assert.equal(err.code, 'STRATA_MISSING');
    return true;
  });
});

test('diverging payloads at identical (version, source, seq) fail with VERSION_CONFLICT', () => {
  const ledger = [
    record('tx-1', 'retail', { version: 2, source: 'nodeA', seq: 1, amount: 100 }),
    record('tx-1', 'retail', { version: 2, source: 'nodeA', seq: 1, amount: 999 }),
    record('tx-2', 'retail', {}),
  ];
  const request = baseRequest({ ledger, strata: [{ id: 'retail', quota: 1 }] });
  assert.throws(() => runSample(request, null), (err) => {
    assert.equal(err.code, 'VERSION_CONFLICT');
    assert.equal(err.details.id, 'tx-1');
    assert.equal(err.details.version, 2);
    return true;
  });
});

test('identical duplicates at the same (version, source, seq) are tolerated', () => {
  const dup = record('tx-1', 'retail', { version: 2, source: 'nodeA', seq: 1 });
  const ledger = [dup, { ...dup }, record('tx-2', 'retail', {})];
  const request = baseRequest({ ledger, strata: [{ id: 'retail', quota: 1 }] });
  const { output } = runSample(request, null);
  assert.equal(output.samples[0].populationSize, 2);
});
