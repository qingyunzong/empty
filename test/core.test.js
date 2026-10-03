'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const core = require('../src/core');
const { makeDir, setup, readCerts, readTests, runCli, BASE_POLICY } = require('../testkit/helpers');

const LOTS = {
  families: { dairy: { risk: 2 }, bakery: { risk: 1 } },
  lots: [
    { lotId: 'L1', productFamily: 'dairy', quantity: 10 },
    { lotId: 'L2', productFamily: 'bakery', quantity: 20 },
  ],
};

test('lot inherits product family risk level', () => {
  const d = core.decide(LOTS.lots[1], LOTS.families, [{ testId: 't', lotId: 'L2', defects: [] }], BASE_POLICY.rules);
  assert.equal(d.effectiveSeverity, 1);
  assert.equal(d.conclusion, 'release');
  assert.equal(d.ruleChain[0].step, 'inherit');
  assert.equal(d.ruleChain[0].inheritedRisk, 1);
});

test('defect severity overrides inherited value', () => {
  const tests = [{ testId: 't', lotId: 'L2', defects: [{ code: 'X', severity: 3 }] }];
  const d = core.decide(LOTS.lots[1], LOTS.families, tests, BASE_POLICY.rules);
  assert.equal(d.effectiveSeverity, 3);
  assert.equal(d.conclusion, 'recall');
  assert.ok(d.ruleChain.some((s) => s.step === 'severity-override'));
});

test('same-severity release/hold conflict: later effective policy wins', () => {
  const tests = [{ testId: 't', lotId: 'L1', defects: [{ code: 'X', severity: 2 }] }];
  const d = core.decide(LOTS.lots[0], LOTS.families, tests, BASE_POLICY.rules);
  assert.equal(d.conclusion, 'release');
  assert.equal(d.decisiveRule, 'rel2');
});

test('recall policy always wins over later release', () => {
  const rules = [
    { id: 'rec', severity: 2, action: 'recall', effectiveFrom: '2026-01-01T00:00:00Z', version: 1 },
    { id: 'rel', severity: 2, action: 'release', effectiveFrom: '2026-06-01T00:00:00Z', version: 1 },
  ];
  const tests = [{ testId: 't', lotId: 'L1', defects: [{ code: 'X', severity: 2 }] }];
  const d = core.decide(LOTS.lots[0], LOTS.families, tests, rules);
  assert.equal(d.conclusion, 'recall');
  assert.equal(d.decisiveRule, 'rec');
  assert.ok(d.ruleChain.some((s) => s.step === 'recall-priority'));
});

test('release cert carries counterexample when perturbation flips conclusion', () => {
  const dir = makeDir();
  setup(dir, {
    lots: LOTS,
    policy: BASE_POLICY,
    tests: [{ type: 'test', testId: 'T1', lotId: 'L2', defects: [] }],
  });
  core.certify(dir, 'L2');
  const [cert] = readCerts(dir);
  assert.equal(cert.conclusion, 'release');
  assert.ok(cert.counterexample, 'counterexample field must be present');
  assert.equal(cert.counterexample.resultingConclusion, 'recall');
  assert.equal(cert.counterexample.perturbation.kind, 'add-defect');
});

test('certify is idempotent for unchanged inputs', () => {
  const dir = makeDir();
  setup(dir, {
    lots: LOTS,
    policy: BASE_POLICY,
    tests: [{ type: 'test', testId: 'T1', lotId: 'L2', defects: [] }],
  });
  core.certify(dir, 'L2');
  core.certify(dir, 'L2');
  const certs = readCerts(dir);
  assert.equal(certs.length, 1);
});

test('missing test records exit 11', () => {
  const dir = makeDir();
  setup(dir, { lots: LOTS, policy: BASE_POLICY, tests: [] });
  const r = runCli(['certify', '--dir', dir, '--lot', 'L1']);
  assert.equal(r.status, 11);
});

test('revoking unknown test exits 11', () => {
  const dir = makeDir();
  setup(dir, {
    lots: LOTS,
    policy: BASE_POLICY,
    tests: [{ type: 'test', testId: 'T1', lotId: 'L1', defects: [] }],
  });
  const r = runCli(['revoke', '--dir', dir, '--test', 'NOPE']);
  assert.equal(r.status, 11);
});

test('policy version gap exits 12', () => {
  const dir = makeDir();
  const badPolicy = {
    policyId: 'p',
    versions: [1, 3],
    rules: [
      { id: 'a', severity: 1, action: 'release', effectiveFrom: '2026-01-01T00:00:00Z', version: 1 },
      { id: 'b', severity: 2, action: 'hold', effectiveFrom: '2026-01-01T00:00:00Z', version: 3 },
    ],
  };
  setup(dir, {
    lots: LOTS,
    policy: badPolicy,
    tests: [{ type: 'test', testId: 'T1', lotId: 'L1', defects: [] }],
  });
  const r = runCli(['certify', '--dir', dir]);
  assert.equal(r.status, 12);
  assert.match(r.stderr, /version gap/);
});

test('hash mismatch on verify exits 10', () => {
  const dir = makeDir();
  setup(dir, {
    lots: LOTS,
    policy: BASE_POLICY,
    tests: [{ type: 'test', testId: 'T1', lotId: 'L1', defects: [] }],
  });
  core.certify(dir, 'L1');
  // tamper with inputs after certification
  fs.appendFileSync(
    path.join(dir, 'tests.jsonl'),
    JSON.stringify({ type: 'test', testId: 'T2', lotId: 'L1', defects: [{ code: 'Y', severity: 3 }] }) + '\n'
  );
  const r = runCli(['verify', '--dir', dir]);
  assert.equal(r.status, 10);
});

test('canonical serialization is key-order independent', () => {
  const a = core.hashObject({ x: 1, y: [2, { b: 1, a: 2 }] });
  const b = core.hashObject({ y: [2, { a: 2, b: 1 }], x: 1 });
  assert.equal(a, b);
});
