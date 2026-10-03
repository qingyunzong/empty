import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';

function ok(args) {
  const res = runCli(args);
  assert.equal(res.status, 0, `expected success, got stderr: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function fail(args) {
  const res = runCli(args);
  assert.equal(res.status, 1, `expected failure, got stdout: ${res.stdout}`);
  return JSON.parse(res.stderr);
}

function writeSpec(dir, spec, name = 'spec.json') {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(spec));
  return path;
}

function acceptanceSpec(budget) {
  return {
    name: 'cli-acceptance',
    budget,
    target: { artifact: 'score', type: 'metric' },
    tasks: [
      { name: 'fetch', cost: 10, produces: [{ name: 'raw', type: 'file' }] },
      { name: 'synth', cost: 10, produces: [{ name: 'raw2', type: 'dataset' }] },
      { name: 'evaluate', cost: 10, requires: 'fetch | synth', produces: [{ name: 'score', type: 'metric' }] },
    ],
  };
}

test('cli: create, plan with certificate, revise, and re-plan across versions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'exp-planner-cli-'));
  const state = join(dir, 'state.json');
  const specPath = writeSpec(dir, acceptanceSpec(20));

  assert.deepEqual(ok(['create', specPath, '--state', state]), { version: 1, state });

  const plan1 = ok(['plan', '--state', state]);
  assert.equal(plan1.version, 1);
  assert.deepEqual(plan1.plans, [
    { tasks: ['evaluate', 'fetch'], cost: 20 },
    { tasks: ['evaluate', 'synth'], cost: 20 },
  ]);
  assert.match(plan1.certificate, /^sha256:[0-9a-f]{64}$/);

  const plan1Again = ok(['plan', '--state', state]);
  assert.equal(plan1Again.certificate, plan1.certificate, 'certificate is reproducible');

  const revised = ok(['revise', 'fetch', '4', '--state', state]);
  assert.equal(revised.version, 2);

  const plan2 = ok(['plan', '--state', state]);
  assert.equal(plan2.version, 2);
  assert.deepEqual(plan2.plans, [{ tasks: ['evaluate', 'fetch'], cost: 14 }]);

  const oldPlan = ok(['plan', '--version', '1', '--state', state]);
  assert.equal(oldPlan.certificate, plan1.certificate, 'old version is retained');

  assert.deepEqual(ok(['versions', '--state', state]), { versions: [1, 2] });
});

test('cli: infeasible budget exits 1 with a structured error and no plan JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'exp-planner-cli-'));
  const state = join(dir, 'state.json');
  writeSpec(dir, acceptanceSpec(5));
  ok(['create', join(dir, 'spec.json'), '--state', state]);

  const res = runCli(['plan', '--state', state]);
  assert.equal(res.status, 1);
  assert.equal(res.stdout, '');
  const err = JSON.parse(res.stderr);
  assert.equal(err.error.code, 'E_NO_FEASIBLE_SET');
});

test('cli: static type mismatch rejects creation and leaves no state behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'exp-planner-cli-'));
  const state = join(dir, 'state.json');
  const bad = acceptanceSpec(20);
  bad.target = { artifact: 'raw', type: 'metric' };
  const specPath = writeSpec(dir, bad);

  const err = fail(['create', specPath, '--state', state]);
  assert.equal(err.error.code, 'E_TARGET_TYPE');
  assert.equal(existsSync(state), false);
});
