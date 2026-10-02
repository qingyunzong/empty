import test from 'node:test';
import assert from 'node:assert/strict';
import { emit, runCli, tmpStore, readState } from './helpers.js';

test('CLI 完整生命周期与非法迁移退出码 3', () => {
  const dir = tmpStore('lifecycle');
  assert.equal(emit(dir, 'T1', 'create', 'WO-1').code, 0);
  assert.equal(emit(dir, 'T1', 'assign', 'WO-1', ['--data', '{"team":"alpha"}', '--actor', 'wang']).code, 0);
  assert.equal(emit(dir, 'T1', 'start', 'WO-1').code, 0);
  assert.equal(emit(dir, 'T1', 'complete', 'WO-1').code, 0);
  assert.equal(readState(dir).orders['WO-1'].status, 'completed');

  // complete 后 start -> 3
  let r = emit(dir, 'T1', 'start', 'WO-1');
  assert.equal(r.code, 3);
  assert.equal(r.stderr.error.kind, 'illegal-transition');

  // 未知工单 -> 3
  r = emit(dir, 'T1', 'start', 'WO-404');
  assert.equal(r.code, 3);
  assert.equal(r.stderr.error.kind, 'unknown-order');
});

test('cancel 后 assign 退出码 3', () => {
  const dir = tmpStore('cancel');
  emit(dir, 'T1', 'create', 'WO-2');
  assert.equal(emit(dir, 'T1', 'cancel', 'WO-2').code, 0);
  const r = emit(dir, 'T1', 'assign', 'WO-2', ['--data', '{"team":"alpha"}']);
  assert.equal(r.code, 3);
  assert.equal(r.stderr.error.kind, 'illegal-transition');
});

test('报警联动：raise 阻塞 complete，clear 后放行', () => {
  const dir = tmpStore('alarm');
  emit(dir, 'T1', 'create', 'WO-3');
  emit(dir, 'T1', 'assign', 'WO-3', ['--data', '{"team":"alpha"}']);
  emit(dir, 'T1', 'start', 'WO-3');
  assert.equal(emit(dir, 'T1', 'raise', 'WO-3', ['--data', '{"alarm":"A1"}']).code, 0);
  let r = emit(dir, 'T1', 'complete', 'WO-3');
  assert.equal(r.code, 3);
  assert.match(r.stderr.error.message, /alarm-active/);
  assert.equal(emit(dir, 'T1', 'clear', 'WO-3', ['--data', '{"alarm":"A1"}']).code, 0);
  assert.equal(emit(dir, 'T1', 'complete', 'WO-3').code, 0);
  assert.equal(readState(dir).orders['WO-3'].status, 'completed');
});

test('stderr 为 JSON；用法错误退出码 2', () => {
  const r = runCli(['emit', '--store', '/tmp/x']);
  assert.equal(r.code, 2);
  assert.equal(r.stderr.error.kind, 'usage');
  const r2 = runCli(['nonsense']);
  assert.equal(r2.code, 2);
});
