'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runSample } = require('../src/index');
const { baseRequest, record } = require('./helpers');

function competingLedger() {
  // tx-1 arrives from two sources with competing versions.
  return [
    record('tx-1', 'retail', { version: 1, source: 'nodeB', seq: 5, amount: 111 }),
    record('tx-1', 'retail', { version: 2, source: 'nodeA', seq: 1, amount: 222 }),
    record('tx-2', 'retail', { version: 1, source: 'nodeA', seq: 2, amount: 50 }),
    record('tx-2', 'retail', { version: 1, source: 'nodeB', seq: 1, amount: 60 }),
  ];
}

test('higher version wins regardless of arrival order', () => {
  const ledger = competingLedger();
  const reversed = ledger.slice().reverse();
  const request = (l) => baseRequest({ ledger: l, strata: [{ id: 'retail', quota: 1 }] });
  const a = runSample(request(ledger), null).output;
  const b = runSample(request(reversed), null).output;
  assert.deepEqual(a, b);
  // Winner for tx-1 is version 2 (amount 222); population has 2 records.
  assert.equal(a.samples[0].populationSize, 2);
});

test('version tie broken by source, then seq', () => {
  const ledger = [
    record('tx-1', 'retail', { version: 1, source: 'nodeA', seq: 9, amount: 10 }),
    record('tx-1', 'retail', { version: 1, source: 'nodeB', seq: 1, amount: 20 }),
    record('tx-2', 'retail', {}),
  ];
  const request = baseRequest({ ledger, strata: [{ id: 'retail', quota: 2 }] });
  const { output } = runSample(request, null);
  // nodeB > nodeA at equal version, so amount 20 wins.
  const tx1 = output.samples[0].population.find((p) => p.id === 'tx-1');
  assert.ok(tx1);

  const seqLedger = [
    record('tx-1', 'retail', { version: 1, source: 'nodeA', seq: 2, amount: 30 }),
    record('tx-1', 'retail', { version: 1, source: 'nodeA', seq: 1, amount: 40 }),
    record('tx-2', 'retail', {}),
  ];
  const seqRequest = baseRequest({ ledger: seqLedger, strata: [{ id: 'retail', quota: 2 }] });
  const seqOut = runSample(seqRequest, null).output;
  assert.equal(seqOut.samples[0].populationSize, 2);
});

test('concurrent history: out-of-order versions resolve to the same population hash', () => {
  const ordered = [
    record('tx-1', 'retail', { version: 1, source: 'nodeA', seq: 1, amount: 1 }),
    record('tx-1', 'retail', { version: 3, source: 'nodeA', seq: 1, amount: 3 }),
    record('tx-1', 'retail', { version: 2, source: 'nodeA', seq: 1, amount: 2 }),
    record('tx-2', 'retail', {}),
  ];
  const shuffled = [ordered[2], ordered[0], ordered[3], ordered[1]];
  const mk = (l) => baseRequest({ ledger: l, strata: [{ id: 'retail', quota: 1 }] });
  const a = runSample(mk(ordered), null).output;
  const b = runSample(mk(shuffled), null).output;
  assert.equal(a.samples[0].populationHash, b.samples[0].populationHash);
  assert.equal(a.merkleRoot, b.merkleRoot);
});
