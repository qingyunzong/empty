import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function runCli(stateFile, commands, env = {}) {
  return new Promise((resolve, reject) => {
    // 本沙箱中 node 父子进程间的 pipe 不转发数据，改用临时文件承载 stdin/stdout。
    const inFile = `${stateFile}.stdin.json`;
    const outFile = `${stateFile}.stdout.json`;
    fs.writeFileSync(inFile, JSON.stringify(commands));
    const inFd = fs.openSync(inFile, 'r');
    const outFd = fs.openSync(outFile, 'w');
    const child = spawn(process.execPath, [cliPath, '--state', stateFile], {
      env: { ...process.env, ...env },
      stdio: [inFd, outFd, 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      fs.closeSync(inFd);
      fs.closeSync(outFd);
      const stdout = fs.readFileSync(outFile, 'utf8');
      let body = null;
      try { body = JSON.parse(stdout); } catch { /* 保留原始输出 */ }
      resolve({ code, body, stdout, stderr });
    });
  });
}

const MOLD = {
  cmd: 'addMold', id: 'M1', cycleMinutes: 100, maintenanceMinutes: 20,
  usedMinutes: 90, calendar: [{ start: 0, end: 100000 }],
};

test('CLI 端到端：JSON 命令进，JSON 结果出，状态跨进程持久', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tooling-cli-'));
  const file = path.join(dir, 'state.json');
  const r1 = await runCli(file, [MOLD, { cmd: 'reserve', orderId: 'O1', durationMinutes: 50 }]);
  assert.equal(r1.code, 0, r1.stderr);
  assert.equal(r1.body.results.length, 2);
  assert.ok(r1.body.results.every((r) => r.ok));
  const reserve = r1.body.results[1];
  assert.equal(reserve.moldId, 'M1');
  assert.deepEqual(reserve.maintenances, [{ start: 0, end: 20 }]);
  assert.deepEqual([reserve.start, reserve.end], [20, 70]);
  // 第二个进程读取同一状态文件
  const r2 = await runCli(file, [
    { cmd: 'correct', orderId: 'O1', deltaMinutes: 30 },
    { cmd: 'schedule' },
  ]);
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(r2.body.results[0].durationMinutes, 80);
  const events = r2.body.results[1].schedule.M1.events;
  assert.deepEqual(events.map((e) => e.type), ['maintenance', 'order']);
});

test('CLI 故障注入：rename 前崩溃，旧状态不变，恢复后重放成功', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tooling-cli-fault-'));
  const file = path.join(dir, 'state.json');
  // 第一次：注入 beforeRename 故障，所有提交都在 rename 前崩溃
  const bad = await runCli(file, [MOLD, { cmd: 'reserve', orderId: 'O1', durationMinutes: 50 }], {
    TOOLING_FAULT_AT: 'beforeRename',
  });
  assert.equal(bad.code, 1);
  assert.ok(bad.body.results.every((r) => !r.ok));
  assert.match(bad.body.results[0].error, /simulated crash at beforeRename/);
  assert.ok(!fs.existsSync(file), '提交未生效，状态文件不存在');
  assert.ok(!fs.existsSync(`${file}.tmp`), '临时文件已清理');
  // 第二次：无故障，同样命令重放成功 —— 无半笔事务残留
  const good = await runCli(file, [MOLD, { cmd: 'reserve', orderId: 'O1', durationMinutes: 50 }]);
  assert.equal(good.code, 0, good.stderr);
  assert.ok(good.body.results.every((r) => r.ok));
  const r3 = await runCli(file, [{ cmd: 'state' }]);
  assert.deepEqual(Object.keys(r3.body.results[0].state.orders), ['O1']);
});

test('CLI 单命令失败回滚，后续命令基于一致状态继续', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tooling-cli-rb-'));
  const file = path.join(dir, 'state.json');
  const r = await runCli(file, [
    MOLD,
    { cmd: 'reserve', orderId: 'O1', durationMinutes: 50 },
    { cmd: 'cancel', orderId: 'GHOST' }, // 失败
    { cmd: 'reserve', orderId: 'O2', durationMinutes: 10 },
    { cmd: 'state' },
  ]);
  assert.equal(r.code, 1);
  assert.deepEqual(r.body.results.map((x) => x.ok), [true, true, false, true, true]);
  const state = r.body.results[4].state;
  assert.deepEqual(Object.keys(state.orders).sort(), ['O1', 'O2']);
});

test('CLI 未知命令返回 JSON 错误', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tooling-cli-err-'));
  const file = path.join(dir, 'state.json');
  const r = await runCli(file, [{ cmd: 'bogus' }]);
  assert.equal(r.code, 1);
  assert.match(r.body.results[0].error, /unknown command/);
});
