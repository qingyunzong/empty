import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { newState, saveState, loadState, ckptPath } from '../src/state.js';
import { execute } from '../src/runner.js';
import { tmpdir } from './helpers.js';

function makeState(dir, dagDoc, plan) {
  const statePath = path.join(dir, 'state.json');
  const state = newState({ dag: dagDoc, budget: { cpu: 99, mem: 99, wall: 99 }, plan });
  saveState(statePath, state);
  return statePath;
}

test('acceptance 3: crash after checkpoint, before completion; resume repeats no side effects', () => {
  const dir = tmpdir();
  const dag = {
    tasks: [
      { id: 'a', deps: [], cost: { cpu: 1, mem: 1, wall: 1 } },
      { id: 'b', deps: ['a'], cost: { cpu: 1, mem: 1, wall: 1 }, crash: 'after-checkpoint' },
      { id: 'c', deps: ['b'], cost: { cpu: 1, mem: 1, wall: 1 } },
    ],
  };
  const statePath = makeState(dir, dag, ['a', 'b', 'c']);

  const first = execute(statePath, loadState(statePath));
  assert.equal(first.status, 'crashed');
  assert.equal(first.task, 'b');
  assert.deepEqual(first.state.completed, ['a']);
  assert.deepEqual(first.state.checkpointed, ['a', 'b']);
  // b wrote its checkpoint but was never marked complete.
  assert.ok(first.state.log.includes('EXEC b'));
  assert.ok(first.state.log.includes('CKPT b'));
  assert.ok(!first.state.log.includes('DONE b'));

  const second = execute(statePath, loadState(statePath));
  assert.equal(second.status, 'done');
  assert.deepEqual(second.state.completed, ['a', 'b', 'c']);
  const log = second.state.log;
  // Side effects (EXEC) of b happened exactly once across crash + resume.
  assert.equal(log.filter((l) => l === 'EXEC b').length, 1);
  assert.ok(log.includes('RESUME b'));
  assert.ok(log.includes('DONE b'));
  assert.ok(log.includes('EXEC c'));
});

test('retries: task fails failAttempts times then succeeds', () => {
  const dir = tmpdir();
  const dag = {
    tasks: [
      { id: 'flaky', deps: [], failAttempts: 2, retries: 2 },
      { id: 'after', deps: ['flaky'] },
    ],
  };
  const statePath = makeState(dir, dag, ['flaky', 'after']);
  const result = execute(statePath, loadState(statePath));
  assert.equal(result.status, 'done');
  assert.equal(result.state.attempts.flaky, 3);
  assert.deepEqual(result.state.completed, ['flaky', 'after']);
  assert.deepEqual(
    result.state.log.filter((l) => l.startsWith('FAIL')),
    ['FAIL flaky 1', 'FAIL flaky 2'],
  );
});

test('retries exhausted: task fails, dependents are skipped', () => {
  const dir = tmpdir();
  const dag = {
    tasks: [
      { id: 'flaky', deps: [], failAttempts: 5, retries: 2 },
      { id: 'after', deps: ['flaky'] },
      { id: 'indep', deps: [] },
    ],
  };
  const statePath = makeState(dir, dag, ['flaky', 'after', 'indep']);
  const result = execute(statePath, loadState(statePath));
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.state.failed, ['flaky']);
  assert.deepEqual(result.state.skipped, ['after']);
  assert.deepEqual(result.state.completed, ['indep']);
});

test('E_LOST_CKPT when a checkpoint record is missing on resume', () => {
  const dir = tmpdir();
  const dag = {
    tasks: [
      { id: 'b', deps: [], crash: 'after-checkpoint' },
      { id: 'c', deps: ['b'] },
    ],
  };
  const statePath = makeState(dir, dag, ['b', 'c']);
  const first = execute(statePath, loadState(statePath));
  assert.equal(first.status, 'crashed');
  fs.rmSync(ckptPath(statePath, 'b'));
  assert.throws(
    () => execute(statePath, loadState(statePath)),
    (e) => e.code === 'E_LOST_CKPT',
  );
});
