'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorkspace, runCli, BASE_POLICY } = require('../testkit/helpers.js');

function setupEvaluated() {
  const ws = makeWorkspace();
  ws.writeJson('policy.json', BASE_POLICY);
  ws.writeJson('lots.json', { lots: [{ lotId: 'L1', productFamily: 'meals' }] });
  ws.writeJsonl('tests.jsonl', [
    { type: 'test', testId: 'T1', lotId: 'L1', defect: 'dent', severity: 1 },
  ]);
  assert.equal(runCli(ws, 'evaluate').status, 0);
  return ws;
}

test('C: genuine certificate verifies successfully', () => {
  const ws = setupEvaluated();
  const res = runCli(ws, 'verify');
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).verified, 1);
});

test('C: forged conclusion is detected (exit 10)', () => {
  const ws = setupEvaluated();
  const certs = ws.readJsonl('cert.jsonl');
  certs[0].conclusion = 'recall'; // attacker rewrites the certified conclusion
  ws.writeJsonl('cert.jsonl', certs);
  const res = runCli(ws, 'verify');
  assert.equal(res.status, 10, res.stderr);
  assert.match(res.stderr, /HASH_MISMATCH/);
});

test('C: forged selfHash is detected (exit 10)', () => {
  const ws = setupEvaluated();
  const certs = ws.readJsonl('cert.jsonl');
  certs[0].selfHash = '0'.repeat(64);
  ws.writeJsonl('cert.jsonl', certs);
  assert.equal(runCli(ws, 'verify').status, 10);
});

test('C: tampered inputs no longer match certified input hash (exit 10)', () => {
  const ws = setupEvaluated();
  ws.appendJsonl('tests.jsonl', { type: 'test', testId: 'T2', lotId: 'L1', defect: 'crack', severity: 3 });
  const res = runCli(ws, 'verify');
  assert.equal(res.status, 10);
});

test('C: deleted certificate is detected (exit 10)', () => {
  const ws = setupEvaluated();
  ws.writeRaw('cert.jsonl', '');
  assert.equal(runCli(ws, 'verify').status, 10);
});
