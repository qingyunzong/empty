'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runCli } = require('../src/cli');

const ROOT = path.join(__dirname, '..');
const run = (cmd, file) => {
  const r = runCli([cmd, file], ROOT);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout);
};

test('CLI reconcile on examples/reconcile.json', () => {
  const out = run('reconcile', 'examples/reconcile.json');
  assert.deepEqual(out.versions, { txn: 'txn-v1', settlement: 'stl-v1', fee: 'fee-v1' });
  const byDay = Object.fromEntries(out.differences.map((d) => [d.day, d]));
  assert.equal(byDay['2024-03-10'].status, 'match');
  assert.equal(byDay['2024-03-11'].status, 'mismatch');
  assert.equal(byDay['2024-03-11'].diff, '5');
  assert.equal(byDay['2024-04-02'].status, 'match');
  assert.equal(out.rateHits.length, 3);
});

test('CLI convert resolves overlap/gap per policy with evidence', () => {
  const out = run('convert', 'examples/convert.json');
  const [u2l, ambEarlier, ambLater, gapLater] = out.results;
  assert.equal(u2l.local, '2024-10-27T02:30:00');
  assert.equal(ambEarlier.utc, '2024-10-27T00:30:00Z');
  assert.equal(ambLater.utc, '2024-10-27T01:30:00Z');
  assert.equal(gapLater.utc, '2024-03-31T01:00:00Z');
  assert.equal(out.evidence.length, 3);
});

test('CLI surfaces ReconError codes as JSON', () => {
  const r = runCli(['reconcile', 'examples/does-not-exist.json'], ROOT);
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.stdout).error, 'E_INTERNAL');
});
