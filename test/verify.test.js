import test from 'node:test';
import assert from 'node:assert/strict';
import { cli, tmpdir, initPair, masterPlan, expectOk } from './helpers.js';

test('verify passes on a fresh master plan', () => {
  const root = tmpdir();
  const { a } = initPair(root);
  const r = cli(['verify', '--dir', a]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json().valid, true);
});

test('budget violation exits 2 with JSON error report', () => {
  const root = tmpdir();
  const plan = masterPlan();
  plan.budget = 0;
  plan.jobs[0].due = 1;
  const { a } = initPair(root, plan);
  const r = cli(['verify', '--dir', a]);
  assert.equal(r.code, 2);
  const report = r.json();
  assert.equal(report.valid, false);
  assert.ok(report.violations.some((v) => v.code === 'BUDGET'));
});

test('capability violation in initial schedule exits 2', () => {
  const root = tmpdir();
  const plan = masterPlan();
  plan.schedule = { M1: ['J1.o1', 'J2.o1'], M2: ['J1.o2', 'J1.o3', 'J2.o2'] };
  const { a } = initPair(root, plan);
  const r = cli(['verify', '--dir', a]);
  assert.equal(r.code, 2);
  assert.ok(r.json().violations.some((v) => v.code === 'CAPABILITY' && v.op === 'J1.o2'));
});

test('apply rejects an incapable machine with exit 2 and does not commit', () => {
  const root = tmpdir();
  const { a } = initPair(root);
  const before = expectOk(cli(['export-cert', '--dir', a])).stdout;
  const r = cli(['apply', '--dir', a, '--change', '{"type":"move","op":"J1.o2","machine":"M2","index":0}']);
  assert.equal(r.code, 2);
  assert.equal(r.errJson().error.code, 'VALIDATION_FAILED');
  const after = expectOk(cli(['export-cert', '--dir', a])).stdout;
  assert.equal(after, before);
});

test('apply rejects an infeasible precedence-inverting move with exit 2', () => {
  const root = tmpdir();
  const { a } = initPair(root);
  const r = cli(['apply', '--dir', a, '--change', '{"type":"move","op":"J1.o3","machine":"M1","index":1}']);
  assert.equal(r.code, 2);
  const report = r.json();
  assert.equal(report.applied, false);
  assert.ok(report.violations.some((v) => v.code === 'PRECEDENCE'));
});

test('unknown command exits 1 with JSON error on stderr', () => {
  const r = cli(['frobnicate']);
  assert.equal(r.code, 1);
  assert.equal(r.errJson().error.code, 'USAGE');
});
