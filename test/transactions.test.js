'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runInput } = require('../src/engine');

test('内层事务失败只回滚内层写入，外层保留并提交', () => {
  const out = runInput({
    stream: [
      { type: 'begin', tx: 't1' },
      { type: 'occupy', id: 'A', resource: 'd', startMs: 0, endMs: 100, baseVersion: 0 },
      { type: 'begin', tx: 't2' },
      { type: 'occupy', id: 'B', resource: 'd', startMs: 200, endMs: 300, baseVersion: 1 },
      { type: 'occupy', id: 'BAD', resource: 'd', startMs: 500, endMs: 400, baseVersion: 2 },
      { type: 'commit' },
      { type: 'commit' },
    ],
  });
  // BAD 触发 INTERVAL_INVERSION，t2 被中止且仅回滚 B
  const err = out.results[4];
  assert.equal(err.status, 'error');
  assert.equal(err.error, 'INTERVAL_INVERSION');
  assert.equal(err.abortedTx, 't2');
  // 第一个 commit 提交的是 t1（t2 已因失败弹出）
  const kept = out.resources.d.intervals.map((i) => i.commandId).sort();
  assert.deepEqual(kept, ['A']);
});

test('外层保存点回滚撤销其后的写入，保存点前的写入保留（部分保留）', () => {
  const out = runInput({
    stream: [
      { type: 'begin', tx: 't1' },
      { type: 'occupy', id: 'A', resource: 'd', startMs: 0, endMs: 100, baseVersion: 0 },
      { type: 'savepoint', name: 'sp1' },
      { type: 'occupy', id: 'B', resource: 'd', startMs: 100, endMs: 200, baseVersion: 1 },
      { type: 'begin', tx: 't2' },
      { type: 'occupy', id: 'C', resource: 'd', startMs: 200, endMs: 300, baseVersion: 2 },
      { type: 'commit' }, // t2 合并进 t1
      { type: 'rollback', to: 'sp1' }, // 撤销 B 与已合并的 C
      { type: 'commit' },
    ],
  });
  assert.equal(out.results[6].status, 'ok');
  const kept = out.resources.d.intervals.map((i) => i.commandId);
  assert.deepEqual(kept, ['A']);
});

test('外层整体回滚撤销全部写入', () => {
  const out = runInput({
    stream: [
      { type: 'begin', tx: 't1' },
      { type: 'occupy', id: 'A', resource: 'd', startMs: 0, endMs: 100, baseVersion: 0 },
      { type: 'begin', tx: 't2' },
      { type: 'occupy', id: 'B', resource: 'd', startMs: 100, endMs: 200, baseVersion: 1 },
      { type: 'commit' },
      { type: 'abort' },
    ],
  });
  assert.equal(out.resources.d.intervals.length, 0);
});

test('未知保存点报错并使当前事务失败回滚', () => {
  const out = runInput({
    stream: [
      { type: 'begin', tx: 't1' },
      { type: 'occupy', id: 'A', resource: 'd', startMs: 0, endMs: 100, baseVersion: 0 },
      { type: 'rollback', to: 'nope' },
    ],
  });
  const err = out.results[2];
  assert.equal(err.status, 'error');
  assert.equal(err.error, 'UNKNOWN_SAVEPOINT');
  assert.equal(err.abortedTx, 't1');
  assert.equal(out.resources.d.intervals.length, 0);
});

test('事务内 REVISION 拒绝不中止事务，可继续提交', () => {
  const out = runInput({
    stream: [
      { type: 'occupy', id: 'c1', resource: 'd', startMs: 0, endMs: 100, baseVersion: 0 },
      { type: 'begin', tx: 't1' },
      { type: 'occupy', id: 'c2', resource: 'd', startMs: 50, endMs: 150, baseVersion: 0 },
      { type: 'occupy', id: 'c3', resource: 'd', startMs: 100, endMs: 200, baseVersion: 1 },
      { type: 'commit' },
    ],
  });
  assert.equal(out.results[2].status, 'rejected');
  assert.equal(out.results[2].certificate.firstOverlapMs, 50);
  assert.equal(out.results[3].status, 'committed');
  assert.deepEqual(out.resources.d.intervals.map((i) => i.commandId), ['c1', 'c3']);
});
