import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

// The sandbox swallows piped stdio of directly spawned node processes, so
// each CLI invocation runs through bash with stdout/stderr redirected to
// files; the exit code propagates as the bash exit status.
const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-cli-'));
  const state = path.join(dir, 'state.json');
  let counter = 0;
  const run = (args) => {
    counter += 1;
    const outFile = path.join(dir, `out-${counter}.txt`);
    const errFile = path.join(dir, `err-${counter}.txt`);
    const command = [process.execPath, CLI, ...args, '--state', state]
      .map(shellQuote)
      .join(' ');
    const result = spawnSync('bash', ['-c', `${command} > ${shellQuote(outFile)} 2> ${shellQuote(errFile)}`], {
      encoding: 'utf8',
    });
    const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
    return {
      status: result.status,
      stdout: read(outFile),
      stderr: read(errFile) || result.stderr,
    };
  };
  const readState = () => JSON.parse(fs.readFileSync(state, 'utf8'));
  return { run, readState };
}

const RECIPE_H2 = JSON.stringify({
  id: 'R1',
  priority: 5,
  temps: [800],
  atmospheres: ['H2'],
  durations: [1],
  crucible: 'alumina',
  gasPerHour: 0,
});
const RECIPE_CO = JSON.stringify({
  id: 'R2',
  priority: 5,
  temps: [800],
  atmospheres: ['CO'],
  durations: [1],
  crucible: 'alumina',
  gasPerHour: 0,
});
const CONFIG = JSON.stringify({
  days: 1,
  maxRunsPerDay: 1,
  slotsPerRun: 4,
  tempDelta: 1000,
  gasBudget: 100,
  crucibles: { alumina: 4 },
  rampProfiles: {},
  hazardous: ['H2', 'CO'],
  minCoverage: 10,
});

test('CLI end-to-end: configure, add_recipe, optimize exit codes', () => {
  const { run } = makeWorkspace();
  assert.equal(run(['configure', '--data', CONFIG]).status, 0);
  assert.equal(run(['add_recipe', '--data', RECIPE_H2]).status, 0);
  assert.equal(run(['add_recipe', '--data', RECIPE_CO]).status, 0);

  // H2 and CO cannot share the single run, coverage 10 needs both -> UNSAT.
  const unsat = run(['optimize']);
  assert.equal(unsat.status, 2, unsat.stderr);
  const unsatOut = JSON.parse(unsat.stdout);
  assert.equal(unsatOut.status, 'UNSAT');
  assert.deepEqual(unsatOut.core, ['R1', 'R2']);

  // Relax coverage -> OPTIMAL, exit 0.
  assert.equal(run(['configure', '--data', JSON.stringify({ minCoverage: 5 })]).status, 0);
  const optimal = run(['optimize']);
  assert.equal(optimal.status, 0, optimal.stderr);
  const optimalOut = JSON.parse(optimal.stdout);
  assert.equal(optimalOut.status, 'OPTIMAL');
  assert.equal(optimalOut.weight, 5);

  // Budget exhaustion -> PENDING, exit 3.
  const pending = run(['optimize', '--budgets', JSON.stringify({ propagation: 0 })]);
  assert.equal(pending.status, 3, pending.stderr);
  assert.equal(JSON.parse(pending.stdout).status, 'PENDING');
});

test('CLI snapshot/restore stack with invalidation', () => {
  const { run, readState } = makeWorkspace();
  run(['configure', '--data', CONFIG]);
  run(['add_recipe', '--data', RECIPE_H2]);
  const snap = JSON.parse(run(['snapshot']).stdout).snapshot;
  run(['add_recipe', '--data', RECIPE_CO]);
  assert.equal(readState().recipes.length, 2);

  const restored = run(['restore', '--id', String(snap)]);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(readState().recipes.length, 1);

  // The popped snapshot is invalidated.
  const again = run(['restore', '--id', String(snap)]);
  assert.equal(again.status, 4);
  const empty = run(['restore']);
  assert.equal(empty.status, 4);
});

test('CLI lock rules and unlock-triggered re-schedule', () => {
  const { run, readState } = makeWorkspace();
  run(['configure', '--data', JSON.stringify({ ...JSON.parse(CONFIG), minCoverage: 0 })]);
  run(['add_recipe', '--data', RECIPE_H2]);
  run(['add_recipe', '--data', RECIPE_CO]);

  const first = JSON.parse(run(['optimize']).stdout);
  assert.equal(first.status, 'OPTIMAL');
  assert.equal(first.scheduled.length, 1);
  const scheduledId = first.scheduled[0].recipe;
  const otherId = scheduledId === 'R1' ? 'R2' : 'R1';

  // Locking the already scheduled variable is rejected with exit 4.
  const badLock = run([
    'lock_slot', '--recipe', scheduledId, '--run', '0',
    '--temp', '800', '--atmosphere', scheduledId === 'R1' ? 'H2' : 'CO', '--duration', '1',
  ]);
  assert.equal(badLock.status, 4);

  // Locking the unscheduled variable is accepted and changes the schedule.
  const okLock = run([
    'lock_slot', '--recipe', otherId, '--run', '0',
    '--temp', '800', '--atmosphere', otherId === 'R1' ? 'H2' : 'CO', '--duration', '1',
  ]);
  assert.equal(okLock.status, 0, okLock.stderr);
  const second = JSON.parse(run(['optimize']).stdout);
  assert.deepEqual(second.scheduled.map((s) => s.recipe), [otherId]);

  // Unlock triggers a re-schedule identical to a fresh recompute.
  assert.equal(run(['unlock_slot', '--recipe', otherId]).status, 0);
  assert.equal(readState().lastSolution, null);
  const third = JSON.parse(run(['optimize']).stdout);
  assert.deepEqual(third.scheduled, first.scheduled);

  // Unlocking without a lock fails with exit 4.
  assert.equal(run(['unlock_slot', '--recipe', otherId]).status, 4);
});

test('CLI usage errors exit 4', () => {
  const { run } = makeWorkspace();
  assert.equal(run(['nonsense']).status, 4);
  assert.equal(run(['add_recipe', '--data', '{bad json']).status, 4);
  assert.equal(run(['lock_slot', '--recipe', 'R1', '--run', '0', '--temp', '1', '--atmosphere', 'air', '--duration', '1']).status, 4);
});
