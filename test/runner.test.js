import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseDag, parseBudget } from '../src/dag.js';
import { planAll } from '../src/planner.js';
import {
  initState, loadState, runSimulation, manualCheckpoint,
  SimulatedCrash, checkpointDir,
} from '../src/runner.js';
import { tmpdir } from './helpers.js';

function makeState(dir, dagObj, budgetObj, { seed = 1, assumeFailRate = 0.5 } = {}) {
  const dag = parseDag(dagObj);
  const budget = parseBudget(budgetObj);
  const plan = planAll(dag, budget, {}).plans[0];
  const state = initState({ dag, budget, planIds: plan.tasks, planIndex: 0, seed, assumeFailRate });
  return { state, statePath: path.join(dir, 'state.json') };
}

const SIMPLE_DAG = { tasks: [
  { id: 'a', deps: [], cpu: 1, mem: 1, wall: 2, failRate: 0 },
  { id: 'b', deps: ['a'], cpu: 1, mem: 1, wall: 3, failRate: 0 },
] };
const SIMPLE_BUDGET = { cpu: 10, mem: 10, wall: 10 };

test('simulation is deterministic for a fixed seed', () => {
  const dir1 = tmpdir();
  const dir2 = tmpdir();
  const dagObj = { tasks: [
    { id: 'x', deps: [], cpu: 1, mem: 1, wall: 1, failRate: 0.4 },
    { id: 'y', deps: ['x'], cpu: 1, mem: 1, wall: 1, failRate: null },
  ] };
  const budget = { cpu: 100, mem: 100, wall: 100 };
  const s1 = makeState(dir1, dagObj, budget, { seed: 99 });
  const s2 = makeState(dir2, dagObj, budget, { seed: 99 });
  const r1 = runSimulation(s1.statePath, s1.state);
  const r2 = runSimulation(s2.statePath, s2.state);
  assert.equal(JSON.stringify(r1), JSON.stringify(r2));
});

test('retries exhaust and the run fails with per-attempt checkpoints as recovery points', () => {
  const dir = tmpdir();
  const dagObj = { tasks: [{ id: 'flaky', deps: [], cpu: 1, mem: 1, wall: 1, failRate: 1, maxRetries: 2 }] };
  const { state, statePath } = makeState(dir, dagObj, { cpu: 100, mem: 100, wall: 100 });
  const out = runSimulation(statePath, state);
  assert.equal(out.status, 'failed');
  assert.equal(out.failedTask, 'flaky');
  assert.equal(out.attempts.flaky, 3); // 1 try + 2 retries
  const ck = out.checkpoints.flaky;
  assert.equal(ck.attempt, 3);
  assert.ok(fs.existsSync(path.join(checkpointDir(statePath), 'flaky.1.json')));
  assert.ok(fs.existsSync(path.join(checkpointDir(statePath), 'flaky.3.json')));
});

test('acceptance 3: crash after checkpoint, before completion — resume does not repeat side effects', () => {
  const dir = tmpdir();
  const { state, statePath } = makeState(dir, SIMPLE_DAG, SIMPLE_BUDGET);
  assert.throws(
    () => runSimulation(statePath, state, { crashAfterCheckpoint: 'b' }),
    (e) => e instanceof SimulatedCrash && e.taskId === 'b',
  );
  const crashed = loadState(statePath);
  assert.equal(crashed.status, 'crashed');
  assert.deepEqual(crashed.pending, { task: 'b', attempt: 1, stage: 'after-checkpoint' });
  assert.deepEqual(crashed.completed, ['a']);
  assert.equal(crashed.effects.filter((e) => e.task === 'b').length, 1);
  const wallAfterCrash = crashed.consumed.wall;

  const resumed = runSimulation(statePath, loadState(statePath));
  assert.equal(resumed.status, 'completed');
  assert.deepEqual(resumed.completed, ['a', 'b']);
  // side effect of b applied exactly once; wall for b consumed exactly once
  assert.equal(resumed.effects.filter((e) => e.task === 'b').length, 1);
  assert.equal(resumed.consumed.wall, wallAfterCrash);
  assert.ok(resumed.log.some((l) => l.event === 'resumed-from-checkpoint' && l.task === 'b'));
});

test('E_LOST_CKPT when the pending checkpoint file is missing', () => {
  const dir = tmpdir();
  const { state, statePath } = makeState(dir, SIMPLE_DAG, SIMPLE_BUDGET);
  assert.throws(
    () => runSimulation(statePath, state, { crashAfterCheckpoint: 'b' }),
    (e) => e instanceof SimulatedCrash,
  );
  fs.rmSync(path.join(checkpointDir(statePath), 'b.1.json'));
  assert.throws(
    () => runSimulation(statePath, loadState(statePath)),
    (e) => e.code === 'E_LOST_CKPT' && e.details.task === 'b',
  );
});

test('E_BUDGET at runtime when retries push consumption over the budget', () => {
  const dir = tmpdir();
  const dagObj = { tasks: [{ id: 'flaky', deps: [], cpu: 1, mem: 1, wall: 5, failRate: 1, maxRetries: 1 }] };
  const { state, statePath } = makeState(dir, dagObj, { cpu: 10, mem: 10, wall: 5 });
  assert.throws(
    () => runSimulation(statePath, state),
    (e) => e.code === 'E_BUDGET',
  );
  const out = loadState(statePath);
  assert.equal(out.status, 'budget-exceeded');
  assert.equal(out.consumed.wall, 10); // two attempts x wall 5
});

test('resume of a terminal state is a no-op', () => {
  const dir = tmpdir();
  const { state, statePath } = makeState(dir, SIMPLE_DAG, SIMPLE_BUDGET);
  const done = runSimulation(statePath, state);
  assert.equal(done.status, 'completed');
  const again = runSimulation(statePath, loadState(statePath));
  assert.equal(again.status, 'completed');
  assert.equal(again.effects.length, done.effects.length);
});

test('manualCheckpoint snapshots a completed task and rejects others', () => {
  const dir = tmpdir();
  const { state, statePath } = makeState(dir, SIMPLE_DAG, SIMPLE_BUDGET);
  assert.throws(() => manualCheckpoint(statePath, state, 'b'), (e) => e.code === 'E_INPUT');
  runSimulation(statePath, state);
  const file = manualCheckpoint(statePath, loadState(statePath), 'b');
  assert.equal(file, 'b.manual.json');
  assert.ok(fs.existsSync(path.join(checkpointDir(statePath), file)));
  const after = loadState(statePath);
  assert.equal(after.checkpoints.b.attempt, 'manual');
});
