'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../src/core');
const { makeDir, setup, readCerts, readTests, runCli, BASE_POLICY } = require('../testkit/helpers');

const LOTS = {
  families: { dairy: { risk: 2 }, bakery: { risk: 1 } },
  lots: [
    { lotId: 'L1', productFamily: 'dairy', quantity: 10 },
    { lotId: 'L2', productFamily: 'bakery', quantity: 20 },
  ],
};

test('A: recall overrides ordinary release at same severity', () => {
  const dir = makeDir();
  const policy = {
    policyId: 'p',
    versions: [1, 2],
    rules: [
      { id: 'rel2-late', severity: 2, action: 'release', effectiveFrom: '2026-06-01T00:00:00Z', version: 2 },
      { id: 'rec2-early', severity: 2, action: 'recall', effectiveFrom: '2026-01-01T00:00:00Z', version: 1 },
    ],
  };
  setup(dir, {
    lots: LOTS,
    policy,
    tests: [{ type: 'test', testId: 'T1', lotId: 'L1', defects: [{ code: 'MICRO', severity: 2 }] }],
  });
  const r = runCli(['certify', '--dir', dir, '--lot', 'L1']);
  assert.equal(r.status, 0, r.stderr);
  const [cert] = readCerts(dir);
  assert.equal(cert.conclusion, 'recall');
  assert.equal(cert.decisiveRule, 'rec2-early');
  assert.ok(cert.ruleChain.some((s) => s.step === 'recall-priority'));
  const v = runCli(['verify', '--dir', dir]);
  assert.equal(v.status, 0, v.stderr);
});

test('B: recompute after revocation is idempotent and old cert is retained', () => {
  const dir = makeDir();
  setup(dir, {
    lots: LOTS,
    policy: BASE_POLICY,
    tests: [
      { type: 'test', testId: 'T1', lotId: 'L1', defects: [{ code: 'A', severity: 3 }] },
      { type: 'test', testId: 'T2', lotId: 'L1', defects: [{ code: 'B', severity: 1 }] },
    ],
  });
  assert.equal(runCli(['certify', '--dir', dir, '--lot', 'L1']).status, 0);
  let certs = readCerts(dir);
  assert.equal(certs.length, 1);
  assert.equal(certs[0].conclusion, 'recall');
  assert.equal(certs[0].status, 'valid');

  // QA revokes the severity-3 test
  assert.equal(runCli(['revoke', '--dir', dir, '--test', 'T1']).status, 0);
  certs = readCerts(dir);
  assert.equal(certs.length, 1, 'old certificate must be retained, not deleted');
  assert.equal(certs[0].status, 'stale', 'revocation flips status to needs-recompute');
  assert.ok(readTests(dir).some((e) => e.type === 'revoke' && e.testId === 'T1'));

  // recompute: new cert reflects remaining tests only
  assert.equal(runCli(['certify', '--dir', dir, '--lot', 'L1']).status, 0);
  certs = readCerts(dir);
  assert.equal(certs.length, 2);
  assert.equal(certs[0].status, 'stale');
  assert.equal(certs[1].status, 'valid');
  assert.equal(certs[1].conclusion, 'release');

  // idempotent: recomputing again changes nothing
  const before = fs.readFileSync(path.join(dir, 'cert.jsonl'), 'utf8');
  const r = runCli(['certify', '--dir', dir, '--lot', 'L1']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /up-to-date/);
  const after = fs.readFileSync(path.join(dir, 'cert.jsonl'), 'utf8');
  assert.equal(after, before);
  assert.equal(readCerts(dir).length, 2);

  // verify still passes with mixed stale/valid history
  assert.equal(runCli(['verify', '--dir', dir]).status, 0);
});

test('C: forged certificate is detected by verify (exit 10)', () => {
  const dir = makeDir();
  setup(dir, {
    lots: LOTS,
    policy: BASE_POLICY,
    tests: [{ type: 'test', testId: 'T1', lotId: 'L1', defects: [{ code: 'A', severity: 3 }] }],
  });
  assert.equal(runCli(['certify', '--dir', dir, '--lot', 'L1']).status, 0);
  const [cert] = readCerts(dir);
  assert.equal(cert.conclusion, 'recall');

  // attacker flips the conclusion to release without a valid signature
  const forged = { ...cert, conclusion: 'release' };
  fs.writeFileSync(path.join(dir, 'cert.jsonl'), JSON.stringify(forged) + '\n');
  const r = runCli(['verify', '--dir', dir]);
  assert.equal(r.status, 10);
  assert.match(r.stderr, /signature mismatch/);

  // attacker also forges the certHash but cannot forge the input hash binding
  const reforged = { ...forged, certHash: core.certSignature(forged) };
  fs.writeFileSync(path.join(dir, 'cert.jsonl'), JSON.stringify(reforged) + '\n');
  const r2 = runCli(['verify', '--dir', dir]);
  assert.equal(r2.status, 10);
  assert.match(r2.stderr, /conclusion mismatch/);
});

// Independent reference implementation for cross-checking.
function referenceDecide(lot, families, tests, rules) {
  const familyRisk = (families[lot.productFamily] || { risk: 0 }).risk;
  let maxSev = 0;
  for (const t of tests) for (const d of t.defects) maxSev = Math.max(maxSev, d.severity);
  const eff = Math.max(familyRisk, maxSev);
  const matching = rules.filter((r) => r.severity === eff);
  if (matching.some((r) => r.action === 'recall')) return 'recall';
  if (matching.length === 0) return 'hold';
  let best = matching[0];
  for (const r of matching) {
    if (String(r.effectiveFrom) > String(best.effectiveFrom)) best = r;
  }
  return best.action;
}

test('D: exhaustive enumeration of defect combinations (n<=10) matches reference', () => {
  const rules = BASE_POLICY.rules;
  const families = { f0: { risk: 0 }, f1: { risk: 1 }, f2: { risk: 2 } };
  const lots = [
    { lotId: 'A', productFamily: 'f0' },
    { lotId: 'B', productFamily: 'f1' },
    { lotId: 'C', productFamily: 'f2' },
  ];
  // pool of 10 defects with varied severities
  const pool = [0, 1, 2, 3, 1, 2, 3, 0, 2, 1].map((s, i) => ({ code: `D${i}`, severity: s }));

  let checked = 0;
  for (const lot of lots) {
    for (let mask = 0; mask < 2 ** pool.length; mask += 1) {
      const defects = pool.filter((_, i) => mask & (1 << i));
      const tests = [{ testId: 't', lotId: lot.lotId, defects }];
      const expected = referenceDecide(lot, families, tests, rules);
      const actual = core.decide(lot, families, tests, rules).conclusion;
      assert.equal(actual, expected, `lot=${lot.lotId} mask=${mask.toString(2)}`);
      checked += 1;
    }
  }
  assert.equal(checked, 3 * 1024);
});
