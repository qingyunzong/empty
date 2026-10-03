'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../src/lib.js');
const { makeWorkspace, runCli, BASE_POLICY } = require('../testkit/helpers.js');

test('A: recall policy always overrides a later release policy at same severity', () => {
  // BASE_POLICY: v1 recall@3 (R3), v2 release@3 (R5). Recall must win despite being older.
  const decision = lib.decide(BASE_POLICY, 1, [3]);
  assert.equal(decision.conclusion, 'recall');
  assert.ok(decision.ruleChain.some((e) => e.includes('R3') && e.includes('recall')));
});

test('A: later release beats earlier hold at same severity when no recall exists', () => {
  // v1 hold@2 (R2), v2 release@2 (R4) -> release wins by later effective version.
  const decision = lib.decide(BASE_POLICY, 1, [2]);
  assert.equal(decision.conclusion, 'release');
  assert.ok(decision.ruleChain.some((e) => e.includes('R4') && e.includes('release@v2')));
});

test('A: defect severity overrides inherited family risk', () => {
  // infant family inherits risk 3 -> recall even with a trivial severity-1 defect.
  const decision = lib.decide(BASE_POLICY, 3, [1]);
  assert.equal(decision.conclusion, 'recall');
  assert.ok(decision.ruleChain.includes('inherit:family-risk=3'));
  // meals family inherits 1, but a severity-3 defect overrides it -> recall.
  const overridden = lib.decide(BASE_POLICY, 1, [1, 3]);
  assert.equal(overridden.conclusion, 'recall');
  assert.ok(overridden.ruleChain.includes('override:defect-severity=3'));
});

test('A: end-to-end via CLI writes recall certificate for inherited high-risk lot', () => {
  const ws = makeWorkspace();
  ws.writeJson('policy.json', BASE_POLICY);
  ws.writeJson('lots.json', { lots: [{ lotId: 'L1', productFamily: 'infant' }] });
  ws.writeJsonl('tests.jsonl', [
    { type: 'test', testId: 'T1', lotId: 'L1', defect: 'cosmetic', severity: 1 },
  ]);
  const res = runCli(ws, 'evaluate');
  assert.equal(res.status, 0, res.stderr);
  const certs = ws.readJsonl('cert.jsonl');
  assert.equal(certs.length, 1);
  assert.equal(certs[0].conclusion, 'recall');
  assert.equal(certs[0].status, 'valid');
});
