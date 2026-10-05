import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = 'dist/src/cli.js';

// 沙箱环境中直接 spawn node 无法捕获管道输出，
// 故经 /bin/sh 将 stdout/stderr/退出码重定向到临时文件再读回。
function run(args: string[]): { status: number; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rectpack-'));
  const out = join(dir, 'out.txt');
  const err = join(dir, 'err.txt');
  const code = join(dir, 'code.txt');
  const quoted = [CLI, ...args].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  spawnSync('/bin/sh', ['-c', `node ${quoted} > '${out}' 2> '${err}'; echo -n $? > '${code}'`], {
    encoding: 'utf8',
  });
  return {
    status: Number(readFileSync(code, 'utf8')),
    stdout: readFileSync(out, 'utf8'),
    stderr: readFileSync(err, 'utf8'),
  };
}

test('CLI 求解 small.json：输出证书并通过全枚举核对', () => {
  const r = run(['examples/small.json']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /最优收益: \d+/);
  assert.match(r.stdout, /占用证书/);
  assert.match(r.stdout, /证书校验: 通过/);
  assert.match(r.stdout, /全枚举核对: 通过/);
});

test('CLI 求解 demo.json（8x8 自动跳过全枚举）', () => {
  const r = run(['examples/demo.json']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /实例: 8x8 网格, 禁区 4 格, 矩形 10 个/);
  assert.match(r.stdout, /证书校验: 通过/);
  assert.match(r.stdout, /全枚举核对: 跳过/);
});

test('CLI 对非法输入返回退出码 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rectpack-'));
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify({ grid: { width: 9, height: 9 }, rectangles: [] }));
  const r = run([bad]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /输入无效/);
});

test('CLI 无参数时打印用法', () => {
  const r = run([]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /用法:/);
});
