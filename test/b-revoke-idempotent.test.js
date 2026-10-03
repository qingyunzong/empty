'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorkspace, runCli, BASE_POLICY } = require('../testkit/helpers.js');

function setup() {
  const ws = makeWorkspace();
  ws.writeJson('policy.json', BASE_POLICY);
  ws.writeJson('lots.json', { lots: [{ lotId: 'L1', productFamily: 'meals' }] });
  ws.writeJsonl('tests.jsonl', [
    { type: 'test', testId: 'T1', lotId: 'L1', defect: 'dent', severity: 2 },
    { type: 'test', testId: 'T2', lotId: 'L1', defect: 'smudge', severity: 1 },
  ]);
  return ws;
}

test('B: revoking a test flips old cert to needs-recompute, old cert retained', () => {
  const ws = setup();
  assert.equal(runCli(ws, 'evaluate').status, 0);
  const before = ws.readJsonl('cert.jsonl');
  assert.equal(before.length, 1);
  assert.equal(before[0].status, 'valid');

  ws.appendJsonl('tests.jsonl', { type: 'revoke', testId: 'T1' });
  assert.equal(runCli(ws, 'evaluate').status, 0);

  const after = ws.readJsonl('cert.jsonl');
  assert.equal(after.length, 2, 'old certificate must be retained, new one appended');
  assert.equal(after[0].certId, before[0].certId, 'old certificate identity preserved');
  assert.equal(after[0].status, 'needs-recompute');
  assert.equal(after[1].status, 'valid');
  assert.notEqual(after[1].inputHash, after[0].inputHash);
});

test('B: recompute after revocation is idempotent (byte-identical cert.jsonl)', () => {
  const ws = setup();
  runCli(ws, 'evaluate');
  ws.appendJsonl('tests.jsonl', { type: 'revoke', testId: 'T1' });
  runCli(ws, 'evaluate');
  const snapshot = ws.readRaw('cert.jsonl');

  const again = runCli(ws, 'evaluate');
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).appended, 0);
  assert.equal(ws.readRaw('cert.jsonl'), snapshot, 'second recompute must not change the ledger');
});

test('B: repeated evaluate with no changes is idempotent from the start', () => {
  const ws = setup();
  runCli(ws, 'evaluate');
  const snapshot = ws.readRaw('cert.jsonl');
  runCli(ws, 'evaluate');
  assert.equal(ws.readRaw('cert.jsonl'), snapshot);
});
