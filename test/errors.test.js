'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorkspace, runCli, BASE_POLICY } = require('../testkit/helpers.js');

test('exit 11: lot without any inspection records', () => {
  const ws = makeWorkspace();
  ws.writeJson('policy.json', BASE_POLICY);
  ws.writeJson('lots.json', { lots: [{ lotId: 'L1', productFamily: 'meals' }] });
  ws.writeJsonl('tests.jsonl', []);
  const res = runCli(ws, 'evaluate');
  assert.equal(res.status, 11);
  assert.match(res.stderr, /MISSING_TEST/);
});

test('exit 11: revoke references an unknown test', () => {
  const ws = makeWorkspace();
  ws.writeJson('policy.json', BASE_POLICY);
  ws.writeJson('lots.json', { lots: [{ lotId: 'L1', productFamily: 'meals' }] });
  ws.writeJsonl('tests.jsonl', [
    { type: 'test', testId: 'T1', lotId: 'L1', defect: 'dent', severity: 1 },
    { type: 'revoke', testId: 'NOPE' },
  ]);
  assert.equal(runCli(ws, 'evaluate').status, 11);
});

test('exit 12: policy version gap', () => {
  const ws = makeWorkspace();
  ws.writeJson('policy.json', {
    families: { meals: 1 },
    versions: [
      { version: 1, rules: [{ id: 'R1', severity: 1, action: 'release' }] },
      { version: 3, rules: [] },
    ],
  });
  ws.writeJson('lots.json', { lots: [{ lotId: 'L1', productFamily: 'meals' }] });
  ws.writeJsonl('tests.jsonl', [
    { type: 'test', testId: 'T1', lotId: 'L1', defect: 'dent', severity: 1 },
  ]);
  const res = runCli(ws, 'evaluate');
  assert.equal(res.status, 12);
  assert.match(res.stderr, /POLICY_VERSION_GAP/);
});

test('exit 12: verify also rejects gapped policy versions', () => {
  const ws = makeWorkspace();
  ws.writeJson('policy.json', { families: { meals: 1 }, versions: [{ version: 2, rules: [] }] });
  ws.writeJson('lots.json', { lots: [] });
  ws.writeJsonl('tests.jsonl', []);
  ws.writeJsonl('cert.jsonl', []);
  assert.equal(runCli(ws, 'verify').status, 12);
});
