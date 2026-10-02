import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { verifyCertificate } from '../src/certificate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 沙箱环境下子进程管道输出会被吞掉，故用临时文件捕获 stdout/stderr。
function runCli(args) {
  const dir = mkdtempSync(join(tmpdir(), 'cnc-cli-'));
  const outFile = join(dir, 'out.json');
  const errFile = join(dir, 'err.json');
  const outFd = openSync(outFile, 'w');
  const errFd = openSync(errFile, 'w');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'cli.js'), ...args], {
      stdio: ['ignore', outFd, errFd],
    });
    child.on('error', reject);
    child.on('close', (status) => {
      closeSync(outFd);
      closeSync(errFd);
      resolve({
        status,
        stdout: readFileSync(outFile, 'utf8'),
        stderr: readFileSync(errFile, 'utf8'),
      });
    });
  });
}

test('CLI: 读 plan.json 输出 SAT plan', async () => {
  const proc = await runCli([join(ROOT, 'examples', 'sat.json')]);
  assert.equal(proc.status, 0, proc.stderr);
  const out = JSON.parse(proc.stdout);
  assert.equal(out.status, 'SAT');
  assert.equal(out.downtime, 10);
  assert.ok(out.plans.length > 1);
  assert.ok(out.plans.every((plan) => plan.downtime === 10 && plan.budgetRemaining === 0));
});

test('CLI: calDue 冲突输出 UNSAT 证书且可复验', async () => {
  const proc = await runCli([join(ROOT, 'examples', 'unsat.json')]);
  assert.equal(proc.status, 0, proc.stderr);
  const out = JSON.parse(proc.stdout);
  assert.equal(out.status, 'UNSAT');
  assert.equal(out.certificate.exhaustive, true);
  const problem = JSON.parse(readFileSync(join(ROOT, 'examples', 'unsat.json'), 'utf8'));
  assert.equal(verifyCertificate(problem, out.certificate).valid, true);
});

test('CLI: 预算为负报 ERR_DOMAIN 并以退出码 1 失败', async () => {
  const proc = await runCli([join(ROOT, 'examples', 'invalid.json')]);
  assert.equal(proc.status, 1);
  const err = JSON.parse(proc.stderr);
  assert.equal(err.error.code, 'ERR_DOMAIN');
});

test('CLI: 缺少参数以退出码 2 失败', async () => {
  const proc = await runCli([]);
  assert.equal(proc.status, 2);
});
