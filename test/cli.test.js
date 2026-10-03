import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli.js';

// The sandbox forbids spawning child processes, so the CLI is exercised
// in-process through runCli(); the thin main() wrapper only maps
// {code, stdout, stderr} onto process streams and exit code.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'sched-cli-'));
  const state = join(dir, 'state.json');
  const plan = join(dir, 'plan.json');
  writeFileSync(plan, JSON.stringify({
    budget: 2,
    tasks: [
      { id: 'A', resources: ['R1'], start: 0, end: 4, deadline: 1 },
      { id: 'D', resources: ['R1'], start: 10, end: 14, deadline: 14 },
    ],
  }));
  const run = (args) => runCli([...args, '--state', state]);
  return { run, plan };
}

test('cli: plan/change/query/undo/redo happy path', () => {
  const { run, plan } = setup();
  assert.match(run(['plan', plan]).stdout, /loaded 2 task/);
  run(['change', '--task', 'A', '--shift', '-3', '--note', '换模 后 延迟 两 小时']);
  run(['change', '--task', 'D', '--shift', '-1', '--note', '提前 换模']);

  const q = run(['query', '--phrase', '换模 后 延迟']);
  assert.equal(q.code, 0);
  assert.match(q.stdout, /"docId":1/);

  const qw = run(['query', '--phrase', '换模', '--window', '8 14']);
  assert.match(qw.stdout, /"docId":2/);
  assert.ok(!qw.stdout.includes('"docId":1'));

  const u = run(['undo']);
  assert.equal(u.code, 0);
  assert.match(u.stdout, /"taskId":"D"/);
  const r = run(['redo']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /"taskId":"D"/);
});

test('cli: E_BUDGET on blocked undo, then redo succeeds', () => {
  const { run, plan } = setup();
  run(['plan', plan]);
  run(['change', '--task', 'A', '--shift', '-3']);
  run(['change', '--task', 'D', '--shift', '-1']);
  assert.equal(run(['undo']).code, 0);
  const blocked = run(['undo']);
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /^E_BUDGET/);
  assert.equal(run(['redo']).code, 0);
});

test('cli: E_EMPTY on empty undo/redo and on query without matches', () => {
  const { run, plan } = setup();
  run(['plan', plan]);
  const u = run(['undo']);
  assert.equal(u.code, 1);
  assert.match(u.stderr, /^E_EMPTY/);
  assert.match(run(['redo']).stderr, /^E_EMPTY/);
  const q = run(['query', '--phrase', '不存在 的 短语']);
  assert.equal(q.code, 1);
  assert.match(q.stderr, /^E_EMPTY/);
});

test('cli: deleting a change note removes it from query results', () => {
  const { run, plan } = setup();
  run(['plan', plan]);
  run(['change', '--task', 'A', '--shift', '-3', '--note', '换模 后 延迟']);
  assert.equal(run(['query', '--phrase', '换模 后 延迟']).code, 0);
  assert.equal(run(['query', '--delete-note', '1']).code, 0);
  const q = run(['query', '--phrase', '换模 后 延迟']);
  assert.equal(q.code, 1);
  assert.match(q.stderr, /^E_EMPTY/);
});

test('cli: plan --suggest picks tie-broken best slot; E_CONFLICT when forced', () => {
  const { run, plan } = setup();
  run(['plan', plan]);
  const ok = run(['plan', '--suggest', '--duration', '2', '--resources', 'R2;R3', '--window', '0 10']);
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /"resources":\["R2"\]/);
  const bad = run(['plan', '--suggest', '--duration', '8', '--resources', 'R1', '--window', '0 10']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /^E_CONFLICT/);
});
