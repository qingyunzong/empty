import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir, writeJson } from './helpers.js';
import { runCli } from '../src/cli.js';

// The sandbox forbids child processes, so the CLI is exercised in-process
// through runCli (bin/replan.js is a thin wrapper around the same code path).
function run(args, { expectFail = false } = {}) {
  const r = runCli(args);
  if (!expectFail && r.code !== 0) {
    throw new Error(`CLI failed (${r.code}): ${r.stderr}`);
  }
  return r;
}

const dagDoc = {
  tasks: [
    { id: 'fetch', deps: [], cost: { cpu: 2, mem: 2, wall: 1 }, value: 10, failRate: 0.1 },
    { id: 'build', deps: ['fetch'], cost: { cpu: 2, mem: 1, wall: 2 }, value: 9, failRate: null },
    { id: 'buildx', deps: [], cost: { cpu: 2, mem: 1, wall: 1 }, value: 1 },
  ],
};
const budgetDoc = { cpu: 4, mem: 3, wall: 3 };

test('CLI plan lists all tied optima with deterministic order', () => {
  const dir = tmpdir();
  const dag = writeJson(dir, 'dag.json', {
    tasks: [
      { id: 'a', deps: [], cost: { cpu: 1, mem: 0, wall: 0 }, value: 1 },
      { id: 'b', deps: [], cost: { cpu: 1, mem: 0, wall: 0 }, value: 1 },
      { id: 'c', deps: [], cost: { cpu: 1, mem: 0, wall: 0 }, value: 1 },
    ],
  });
  const budget = writeJson(dir, 'budget.json', { cpu: 2, mem: 0, wall: 0 });
  const r = run(['plan', dag, budget]);
  const out = JSON.parse(r.stdout);
  assert.equal(out.optimalValue, 2);
  assert.equal(out.tiedPlanCount, 3);
  assert.deepEqual(out.plans.map((p) => p.tasks), [['a', 'b'], ['a', 'c'], ['b', 'c']]);
});

test('CLI plan exits 2 with E_CYCLE on a cyclic dag', () => {
  const dir = tmpdir();
  const dag = writeJson(dir, 'dag.json', {
    tasks: [
      { id: 'a', deps: ['b'] },
      { id: 'b', deps: ['a'] },
    ],
  });
  const budget = writeJson(dir, 'budget.json', budgetDoc);
  const r = run(['plan', dag, budget], { expectFail: true });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /E_CYCLE/);
});

test('CLI checkpoint: ambiguous prefix exits 5 with E_AMBIG', () => {
  const dir = tmpdir();
  // 'build' crashes after its checkpoint, leaving 'buildx' pending in plan.
  const dag = writeJson(dir, 'dag.json', {
    tasks: [
      { id: 'build', deps: [], cost: { cpu: 1, mem: 1, wall: 1 }, crash: 'after-checkpoint' },
      { id: 'buildx', deps: ['build'], cost: { cpu: 1, mem: 1, wall: 1 } },
    ],
  });
  const budget = writeJson(dir, 'budget.json', { cpu: 2, mem: 2, wall: 2 });
  const state = path.join(dir, 'state.json');
  run(['run', '--simulate', dag, budget, '--state', state], { expectFail: true });
  const r = run(['checkpoint', 'bu', '--state', state], { expectFail: true });
  assert.equal(r.code, 5);
  assert.match(r.stderr, /E_AMBIG/);
  // exact id works on a pending planned task
  const ok = run(['checkpoint', 'buildx', '--state', state]);
  assert.equal(JSON.parse(ok.stdout).checkpointed, 'buildx');
  // unknown prefix exits 6 with E_UNKNOWN
  const unk = run(['checkpoint', 'zzz', '--state', state], { expectFail: true });
  assert.equal(unk.code, 6);
});

test('CLI run --simulate + resume: crash after checkpoint, no repeated side effects', () => {
  const dir = tmpdir();
  const dag = writeJson(dir, 'dag.json', {
    tasks: [
      { id: 'a', deps: [], cost: { cpu: 1, mem: 1, wall: 1 } },
      { id: 'b', deps: ['a'], cost: { cpu: 1, mem: 1, wall: 1 }, crash: 'after-checkpoint' },
    ],
  });
  const budget = writeJson(dir, 'budget.json', { cpu: 2, mem: 2, wall: 2 });
  const state = path.join(dir, 'state.json');
  const crashed = run(['run', '--simulate', dag, budget, '--state', state], { expectFail: true });
  assert.equal(crashed.code, 10);
  assert.equal(JSON.parse(crashed.stdout).status, 'crashed');
  const resumed = run(['resume', state]);
  const out = JSON.parse(resumed.stdout);
  assert.equal(out.status, 'done');
  assert.deepEqual(out.completed, ['a', 'b']);
  assert.equal(out.log.filter((l) => l === 'EXEC b').length, 1);
  assert.ok(out.log.includes('RESUME b'));
});

test('acceptance 4: deselect frees budget and triggers re-plan', () => {
  const dir = tmpdir();
  // 'a' crashes after its checkpoint so the run halts with b still pending.
  const dag = writeJson(dir, 'dag.json', {
    tasks: [
      { id: 'a', deps: [], cost: { cpu: 2, mem: 0, wall: 0 }, value: 10, crash: 'after-checkpoint' },
      { id: 'b', deps: [], cost: { cpu: 2, mem: 0, wall: 0 }, value: 9 },
      { id: 'c', deps: [], cost: { cpu: 2, mem: 0, wall: 0 }, value: 1 },
    ],
  });
  const budget = writeJson(dir, 'budget.json', { cpu: 4, mem: 0, wall: 0 });
  const state = path.join(dir, 'state.json');
  const planned = JSON.parse(run(['run', '--simulate', dag, budget, '--state', state], { expectFail: true }).stdout);
  assert.deepEqual(planned.plan, ['a', 'b']); // c excluded: no budget left
  assert.equal(planned.status, 'crashed');
  // Deselect the pending task b: its 2 cpu are freed, c can now enter.
  const r = JSON.parse(run(['deselect', 'b', '--state', state]).stdout);
  assert.equal(r.deselected, 'b');
  assert.equal(r.freedBudgetTriggeringReplan, true);
  assert.deepEqual(r.newPlan, ['a', 'c']);
  // state was persisted
  const st = JSON.parse(fs.readFileSync(state, 'utf8'));
  assert.deepEqual(st.plan, ['a', 'c']);
  assert.deepEqual(st.excluded, ['b']);
  // resume finishes the re-planned set
  const done = JSON.parse(run(['resume', state]).stdout);
  assert.deepEqual(done.completed, ['a', 'c']);
  // deselecting a completed task is rejected
  const late = run(['deselect', 'a', '--state', state], { expectFail: true });
  assert.equal(late.code, 64);
});

test('CLI explain reports selection reasons, budget use and recovery points', () => {
  const dir = tmpdir();
  const dag = writeJson(dir, 'dag.json', dagDoc);
  const budget = writeJson(dir, 'budget.json', budgetDoc);
  const r = run(['explain', dag, budget, '--json']);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.firstPlan, ['build', 'fetch']);
  assert.equal(out.excluded.length, 1);
  assert.equal(out.excluded[0].id, 'buildx');
  assert.match(out.excluded[0].reason, /insufficient budget/);
  assert.deepEqual(out.budget.used, { cpu: 4, mem: 3, wall: 3 });
  assert.equal(out.successInterval[0], 0); // build has unknown failRate
  assert.equal(out.recovery.length, 2);
  // text mode also works
  const text = run(['explain', dag, budget]);
  assert.match(text.stdout, /optimal value: 19/);
});

test('CLI plan --state accounts for already-consumed budget', () => {
  const dir = tmpdir();
  const dag = writeJson(dir, 'dag.json', dagDoc);
  const budget = writeJson(dir, 'budget.json', budgetDoc);
  const state = path.join(dir, 'state.json');
  run(['run', '--simulate', dag, budget, '--state', state]); // completes fetch+build
  const r = JSON.parse(run(['plan', dag, budget, '--state', state]).stdout);
  assert.deepEqual(r.remainingBudget, { cpu: 0, mem: 0, wall: 0 });
  assert.deepEqual(r.plans[0].tasks, []);
});
