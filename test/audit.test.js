import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { emit, runCli, tmpStore } from './helpers.js';

test('审计通过：链、索引、快照、清单一致', () => {
  const dir = tmpStore('audit-ok');
  emit(dir, 'T1', 'create', 'WO-1');
  emit(dir, 'T1', 'assign', 'WO-1', ['--data', '{"team":"alpha"}']);
  const r = runCli(['audit', '--store', dir]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.ok, true);
  assert.deepEqual(r.stdout.checks.map((c) => c.ok), [true, true, true, true]);
  assert.equal(r.stdout.count, 2);
});

test('篡改日志 -> 审计失败退出码 3', () => {
  const dir = tmpStore('audit-tamper');
  emit(dir, 'T1', 'create', 'WO-1');
  const logPath = path.join(dir, 'events.log');
  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  const rec = JSON.parse(lines[0]);
  rec.event.data = { team: 'evil' };
  lines[0] = JSON.stringify(rec);
  fs.writeFileSync(logPath, lines.join('\n') + '\n');
  const r = runCli(['audit', '--store', dir]);
  assert.equal(r.code, 3);
  assert.equal(r.stdout.ok, false);
  assert.equal(r.stdout.checks.find((c) => c.name === 'log-chain').ok, false);
});

test('删除清单 -> 审计失败；日志损坏 -> resume 退出码 2', () => {
  const dir = tmpStore('audit-missing');
  emit(dir, 'T1', 'create', 'WO-1');
  fs.rmSync(path.join(dir, 'audit-manifest.json'));
  const r = runCli(['audit', '--store', dir]);
  assert.equal(r.code, 3);
  assert.equal(r.stdout.checks.find((c) => c.name === 'manifest').ok, false);

  fs.appendFileSync(path.join(dir, 'events.log'), '{"event":{}, "prev":"x", "hash":"y"}\n');
  const res = runCli(['resume', '--store', dir]);
  assert.equal(res.code, 2);
  assert.equal(res.stderr.error.kind, 'corrupt');
});
