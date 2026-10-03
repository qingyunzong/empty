import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../cli.js';

// NOTE: the sandbox forbids spawning child processes, so the CLI is
// exercised in-process via its exported run() (same code path as main).
test('CLI end-to-end flow with exit codes', () => {
  const state = join(mkdtempSync(join(tmpdir(), 'planner-')), 'state.json');

  let r = run(['undo', '--state', state]);
  assert.equal(r.code, 4);
  assert.match(r.stderr, /E_EMPTY/);

  r = run(['change', '--state', state, '--note', '换模后延迟', '--op',
    JSON.stringify({ type: 'add', task: { id: 'a', resources: ['R1'], start: 0, end: 5, due: 5, budget: 2 } })]);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).changeId, 1);

  r = run(['change', '--state', state, '--note', '冲突插入', '--op',
    JSON.stringify({ type: 'add', task: { id: 'b', resources: ['R1'], start: 2, end: 6, due: 6, budget: 0 } })]);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /E_CONFLICT/);

  r = run(['query', '--state', state, '--phrase', '换模 后 延迟']);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout).hits, [1]);

  r = run(['query', '--state', state, '--phrase', '不存在的词']);
  assert.equal(r.code, 4);
  assert.match(r.stderr, /E_EMPTY/);

  r = run(['plan', '--state', state, '--task',
    JSON.stringify({ id: 'x', duration: 3, due: 8, budget: 1, resourceOptions: [['R1'], ['R2', 'R3']] })]);
  assert.equal(r.code, 0);
  const plan = JSON.parse(r.stdout);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.best.delay, 0);

  assert.equal(run(['undo', '--state', state]).code, 0);
  assert.equal(run(['redo', '--state', state]).code, 0);
});

test('plan tie-break: fewer resources, then lexicographic', () => {
  const state = join(mkdtempSync(join(tmpdir(), 'planner-')), 'state.json');
  const r = run(['plan', '--state', state, '--task',
    JSON.stringify({ id: 'x', duration: 2, due: 10, budget: 0, resourceOptions: [['R9', 'R8'], ['R2'], ['R1']] })]);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout).best.resources, ['R1']);
});
