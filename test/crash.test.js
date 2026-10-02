import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { emit, runCli, tmpStore, readState, readIndex, readLogEvents } from './helpers.js';

const CRASH_EXIT = 70;

function setup(label) {
  const dir = tmpStore(label);
  assert.equal(emit(dir, 'T1', 'create', 'WO-1').code, 0);
  return dir;
}

function crashEmit(dir, point) {
  return runCli(
    ['emit', '--store', dir, '--site', 'T1', '--type', 'assign', '--order', 'WO-1',
     '--data', '{"team":"alpha"}', '--actor', 'wang'],
    { env: { MAINT_SYNC_CRASH: point } },
  );
}

test('故障点1: append 前崩溃 —— 无残留，恢复后状态不变', () => {
  const dir = setup('crash-before-append');
  const before = readLogEvents(dir).length;
  const r = crashEmit(dir, 'before-append');
  assert.equal(r.code, CRASH_EXIT);
  assert.equal(readLogEvents(dir).length, before);
  const res = runCli(['resume', '--store', dir]);
  assert.equal(res.code, 0);
  assert.equal(res.stdout.events, before);
  assert.equal(readState(dir).orders['WO-1'].status, 'created');
  assert.equal(runCli(['audit', '--store', dir]).code, 0);
});

test('故障点2: append 后未建索引崩溃 —— 恢复时重建半索引，事件恰好一次生效', () => {
  const dir = setup('crash-after-append');
  const r = crashEmit(dir, 'after-append');
  assert.equal(r.code, CRASH_EXIT);
  // 日志已追加，索引未更新
  assert.equal(readLogEvents(dir).length, 2);
  assert.equal(readIndex(dir).count, 1);
  const res = runCli(['resume', '--store', dir]);
  assert.equal(res.code, 0);
  assert.equal(res.stdout.rebuiltIndex, 1);
  assert.equal(readIndex(dir).count, 2);
  assert.equal(readState(dir).orders['WO-1'].status, 'assigned');
  // 恢复后重复投递同一事件不重复生效
  const ev = readLogEvents(dir)[1];
  const dup = runCli(['apply', '--store', dir, '--event', JSON.stringify(ev)]);
  assert.equal(dup.code, 0);
  assert.equal(dup.stdout.duplicate, true);
  assert.equal(readLogEvents(dir).length, 2);
  assert.equal(readState(dir).orders['WO-1'].history.filter((h) => h === ev.id).length, 1);
  assert.equal(runCli(['audit', '--store', dir]).code, 0);
});

test('故障点3: snapshot rename 前崩溃 —— 旧检查点保留，恢复后重建一致', () => {
  const dir = setup('crash-before-rename');
  const r = crashEmit(dir, 'before-rename');
  assert.equal(r.code, CRASH_EXIT);
  // state.json.tmp 残留、state.json 仍是旧检查点
  assert.equal(fs.existsSync(path.join(dir, 'state.json.tmp')), true);
  assert.equal(readState(dir).orders['WO-1'].status, 'created');
  const res = runCli(['resume', '--store', dir]);
  assert.equal(res.code, 0);
  assert.equal(readState(dir).orders['WO-1'].status, 'assigned');
  assert.equal(readState(dir).lastSeq, 2);
  assert.equal(runCli(['audit', '--store', dir]).code, 0);
});

test('故障点4: audit manifest commit 后崩溃 —— 已提交内容一致，恢复为无操作', () => {
  const dir = setup('crash-after-manifest');
  const r = crashEmit(dir, 'after-manifest');
  assert.equal(r.code, CRASH_EXIT);
  // 清单已提交且与日志一致
  assert.equal(runCli(['audit', '--store', dir]).code, 0);
  const res = runCli(['resume', '--store', dir]);
  assert.equal(res.code, 0);
  assert.equal(res.stdout.events, 2);
  assert.equal(res.stdout.rebuiltIndex, 0);
  assert.equal(readState(dir).orders['WO-1'].status, 'assigned');
  assert.equal(runCli(['audit', '--store', dir]).code, 0);
});
