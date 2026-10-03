import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCLI } from '../src/cli.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mold-plan-cli-'));
}

// Run the CLI in-process (the sandbox forbids spawning subprocesses);
// captures stdout/stderr lines and the exit code.
async function run(args, { stdin = '' } = {}) {
  const outLines = [];
  const errLines = [];
  const code = await runCLI(args, {
    stdin,
    stdout: (s) => outLines.push(s),
    stderr: (s) => errLines.push(s),
  });
  return {
    code,
    stdout: outLines.length ? JSON.parse(outLines[outLines.length - 1]) : null,
    stderr: errLines.length ? JSON.parse(errLines[errLines.length - 1]) : null,
    rawStderr: errLines.join('\n'),
  };
}

const DEF = {
  molds: [
    { id: 'M1', life: 100, changeTime: 2 },
    { id: 'M2', life: 80, changeTime: 3 },
  ],
  shifts: [
    { id: 'S1', budget: 100 },
    { id: 'S2', budget: 80 },
  ],
  jobs: [
    { id: 'J1', units: 40, eligible: ['M1'] },
    { id: 'J2', units: 30, eligible: ['M1', 'M2'] },
    { id: 'J3', units: 20, eligible: ['M2'] },
  ],
};

function writeDef(dir, def = DEF) {
  const defFile = path.join(dir, 'def.json');
  fs.writeFileSync(defFile, JSON.stringify(def));
  return defFile;
}

test('plan produces a feasible plan and verify passes (exit 0)', async () => {
  const dir = tmpdir();
  const plan = await run(['plan', '--dir', dir, '--def', writeDef(dir)]);
  assert.equal(plan.code, 0);
  assert.equal(plan.stdout.feasible, true);
  const verify = await run(['verify', '--dir', dir]);
  assert.equal(verify.code, 0);
  assert.equal(verify.stdout.ok, true);
});

test('plan is deterministic across runs (fixed tie-break, same plan every time)', async () => {
  const plans = [];
  for (let i = 0; i < 3; i++) {
    const dir = tmpdir();
    const r = await run(['plan', '--dir', dir, '--def', writeDef(dir)]);
    plans.push(JSON.stringify(r.stdout.certificate.assignment));
  }
  assert.equal(new Set(plans).size, 1);
});

test('budget boundary via CLI: exact fit feasible, overflow infeasible with certificate kept', async () => {
  const dir = tmpdir();
  const tight = {
    molds: [{ id: 'M1', life: 1000, changeTime: 1 }],
    shifts: [{ id: 'S1', budget: 100 }],
    jobs: [
      { id: 'J1', units: 60, eligible: ['M1'] },
      { id: 'J2', units: 40, eligible: ['M1'] },
    ],
  };
  const okPlan = await run(['plan', '--dir', dir, '--def', writeDef(dir, tight)]);
  assert.equal(okPlan.stdout.feasible, true, 'load == budget is feasible');
  const cert = okPlan.stdout.certificate;
  const add = await run([
    'apply', '--dir', dir,
    '--changes', JSON.stringify({ changes: [{ type: 'addJob', job: { id: 'J3', units: 1, eligible: ['M1'] } }] }),
  ]);
  assert.equal(add.code, 0);
  const badPlan = await run(['plan', '--dir', dir]);
  assert.equal(badPlan.stdout.feasible, false);
  assert.deepEqual(badPlan.stdout.certificate, cert, 'last feasible certificate retained');
  assert.equal(badPlan.stderr.ok, false);
  assert.equal(badPlan.stderr.reason, 'infeasible');
});

test('rollback exit code 3 on locked mold maintenance; 0 on clean rollback', async () => {
  const dir = tmpdir();
  await run(['plan', '--dir', dir, '--def', writeDef(dir)]);
  await run(['apply', '--dir', dir, '--changes', JSON.stringify({
    changes: [{ type: 'unassign', jobId: 'J2' }],
    lockedMolds: ['M1'],
  })]);
  const locked = await run(['rollback', '--dir', dir]);
  assert.equal(locked.code, 3);
  assert.equal(locked.stderr.error.code, 'ROLLBACK');
  await run(['apply', '--dir', dir, '--changes', JSON.stringify({
    changes: [{ type: 'unassign', jobId: 'J3' }],
  })]);
  const clean = await run(['rollback', '--dir', dir]);
  assert.equal(clean.code, 0);
  assert.equal(clean.stdout.ok, true);
});

test('verify exit code 6 on over-budget state', async () => {
  const dir = tmpdir();
  await run(['plan', '--dir', dir, '--def', writeDef(dir)]);
  await run(['apply', '--dir', dir, '--changes', JSON.stringify({
    changes: [
      { type: 'addJob', job: { id: 'JBIG', units: 500, eligible: ['M1'] } },
      { type: 'assign', jobId: 'JBIG', shift: 0, mold: 'M1' },
    ],
  })]);
  const verify = await run(['verify', '--dir', dir]);
  assert.equal(verify.code, 6);
  assert.equal(verify.stderr.ok, false);
  assert.ok(verify.stdout.problems.length > 0);
});

test('usage errors exit with code 2 and JSON stderr', async () => {
  const noCmd = await run([]);
  assert.equal(noCmd.code, 2);
  assert.equal(noCmd.stderr.error.code, 'USAGE');
  const badSync = await run(['sync', '--dir', tmpdir()]);
  assert.equal(badSync.code, 2);
});

test('sync command exchanges increments between two terminals', async () => {
  const dirA = tmpdir();
  const dirB = tmpdir();
  await run(['plan', '--dir', dirA, '--terminal', 'TA', '--def', writeDef(dirA)]);
  await run(['plan', '--dir', dirB, '--terminal', 'TB', '--def', writeDef(dirB)]);
  await run(['apply', '--dir', dirA, '--terminal', 'TA', '--changes', JSON.stringify({
    changes: [
      { type: 'addJob', job: { id: 'JX', units: 5, eligible: ['M1'] } },
      { type: 'assign', jobId: 'JX', shift: 0, mold: 'M1' },
    ],
  })]);
  const sync = await run(['sync', '--dir', dirA, '--terminal', 'TA', '--peer', dirB, '--peer-terminal', 'TB']);
  assert.equal(sync.code, 0);
  assert.equal(sync.stdout.converged, true);
  const verifyB = await run(['verify', '--dir', dirB, '--terminal', 'TB']);
  assert.equal(verifyB.code, 0);
});

test('apply reads changes from stdin when --changes is omitted', async () => {
  const dir = tmpdir();
  await run(['plan', '--dir', dir, '--def', writeDef(dir)]);
  const r = await run(['apply', '--dir', dir], {
    stdin: JSON.stringify({ changes: [{ type: 'unassign', jobId: 'J1' }] }),
  });
  assert.equal(r.code, 0);
  const status = await run(['status', '--dir', dir]);
  assert.equal(status.stdout.feasible, false, 'J1 unassigned -> infeasible');
});

test('stderr is always JSON', async () => {
  const r = await run(['bogus-command']);
  assert.equal(r.code, 2);
  assert.doesNotThrow(() => JSON.parse(r.rawStderr));
});
