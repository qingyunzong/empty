'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCli } = require('../cli');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'equip-award-'));
}

const DATA = {
  order: [{ order: 'O1', process: 'P1' }, { order: 'O1', process: 'P2' }],
  machines: [
    { machine: 'M1', process: 'P1', cert_expiry: '2027-01-01' },
    { machine: 'M1', process: 'P2', cert_expiry: '2027-01-01' },
    { machine: 'M2', process: 'P1', cert_expiry: '2027-01-01' },
    { machine: 'M3', process: 'P2', cert_expiry: '2027-01-01' },
    { machine: 'M4', process: 'P1', cert_expiry: null },
  ],
  costs: [
    { machine: 'M1', shift_cost: 18 },
    { machine: 'M2', shift_cost: 6 },
    { machine: 'M3', shift_cost: 6 },
    { machine: 'M4', shift_cost: 1 },
  ],
  budget: 20,
};

test('CLI: candidates / award / apply-change end-to-end', () => {
  const dir = tmpdir();
  const dataPath = path.join(dir, 'data.json');
  const statePath = path.join(dir, 'state.json');
  const changePath = path.join(dir, 'change.json');
  fs.writeFileSync(dataPath, JSON.stringify(DATA));

  const cand = runCli(['candidates', '--input', dataPath]);
  assert.equal(cand.exitCode, 0);
  assert.deepEqual(cand.output.processes, ['P1', 'P2']);
  // M4 (null cert) must not appear in any qualified list or feasible combo.
  assert.ok(cand.output.perProcess.every((r) => !r.machines.includes('M4')));
  assert.ok(cand.output.feasible.every((c) => !c.machines.includes('M4')));
  assert.deepEqual(cand.output.feasible[0].machines, ['M1']);

  const first = runCli(['award', '--input', dataPath, '--state', statePath]);
  assert.equal(first.exitCode, 0);
  assert.equal(first.output.status, 'awarded');
  assert.deepEqual(first.output.machines, ['M1']);
  assert.ok(fs.existsSync(statePath), 'state file written');

  fs.writeFileSync(changePath, JSON.stringify({ type: 'set_budget', budget: 15 }));
  const cut = runCli(['apply-change', '--state', statePath, '--change', changePath]);
  assert.equal(cut.exitCode, 0);
  assert.deepEqual(cut.output.retracted.machines, ['M1']);
  assert.deepEqual(cut.output.diff, { removed: ['M1'], added: ['M2', 'M3'] });
  assert.equal(cut.output.award.status, 'awarded');
  assert.deepEqual(cut.output.award.machines, ['M2', 'M3']);

  // Revoking M1's P1 cert changes nothing: {M2,M3} still covers everything.
  fs.writeFileSync(changePath, JSON.stringify({ type: 'revoke_cert', machine: 'M1', process: 'P1' }));
  const noop = runCli(['apply-change', '--state', statePath, '--change', changePath]);
  assert.equal(noop.exitCode, 0);
  assert.deepEqual(noop.output.diff, { removed: [], added: [] });
  assert.deepEqual(noop.output.award.machines, ['M2', 'M3']);

  // Revoking M2's P1 cert removes the last valid P1 certificate.
  fs.writeFileSync(changePath, JSON.stringify({ type: 'revoke_cert', machine: 'M2', process: 'P1' }));
  const gone = runCli(['apply-change', '--state', statePath, '--change', changePath]);
  assert.equal(gone.exitCode, 1);
  assert.equal(gone.output.award.status, 'infeasible');
  assert.equal(gone.output.award.reason, 'missing_capability');
  assert.equal(gone.output.award.process, 'P1');

  // State file on disk reflects the final award.
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(persisted.award.status, 'infeasible');
});

test('CLI: award exits non-zero and reports certificate when infeasible', () => {
  const dir = tmpdir();
  const dataPath = path.join(dir, 'data.json');
  fs.writeFileSync(dataPath, JSON.stringify({ ...DATA, budget: 5 }));
  const result = runCli(['award', '--input', dataPath]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.status, 'infeasible');
  assert.equal(result.output.reason, 'budget');
  assert.equal(result.output.min_cost, 12);
});

test('CLI: usage error on missing arguments', () => {
  assert.equal(runCli([]).exitCode, 2);
  assert.equal(runCli(['award']).exitCode, 2);
  assert.equal(runCli(['nope']).exitCode, 2);
});
