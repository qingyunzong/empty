import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { run } from '../src/cli.js';

const example = (name) => fileURLToPath(new URL(`../examples/${name}`, import.meta.url));

function runCli(args) {
  let stdout = '';
  let stderr = '';
  const code = run(args, {
    stdout: (s) => { stdout += s; },
    stderr: (s) => { stderr += s; },
  });
  return { code, stdout, stderr };
}

test('CLI: plan 求解小例，退出码 0', () => {
  const r = runCli(['plan', example('small.json'), '--budget', '100000']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'optimal');
  assert.ok(Number.isInteger(out.makespan));
  assert.ok(Number.isInteger(out.totalTravel));
  assert.equal(out.assignments.length, 4);
});

test('CLI: 负移动时间以退出码 2 报错', () => {
  const r = runCli(['plan', example('bad-travel.json')]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /negative travel time/);
});

test('CLI: 非法窗口以退出码 2 报错', () => {
  const r = runCli(['plan', example('bad-window.json')]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /illegal window/);
});

test('CLI: 缺失技能声明以退出码 2 报错', () => {
  const r = runCli(['plan', example('bad-skill.json')]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /missing skill/);
});

test('CLI: 不可行实例退出码 1 且输出冲突证明', () => {
  const r = runCli(['plan', example('infeasible.json')]);
  assert.equal(r.code, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'infeasible');
  assert.equal(out.conflict.type, 'skill');
});

test('CLI: 预算耗尽退出码 3 且列出未决任务', () => {
  const r = runCli(['plan', example('medium.json'), '--budget', '1']);
  assert.equal(r.code, 3);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'unknown');
  assert.ok(out.pending.length > 0);
});
