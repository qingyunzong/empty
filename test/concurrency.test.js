'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runInput } = require('../src/engine');

test('重叠命令被 REVISION 拒绝，冲突证书包含双方命令ID与首个重叠毫秒', () => {
  const out = runInput({
    stream: [
      { type: 'occupy', id: 'c1', resource: 'dev1', startMs: 1000, endMs: 2000, baseVersion: 0 },
      { type: 'occupy', id: 'c2', resource: 'dev1', startMs: 1500, endMs: 2500, baseVersion: 0 },
    ],
  });
  assert.equal(out.results[0].status, 'committed');
  assert.equal(out.results[0].version, 1);
  const rej = out.results[1];
  assert.equal(rej.status, 'rejected');
  assert.equal(rej.reason, 'REVISION');
  assert.deepEqual(rej.certificate, {
    commandId: 'c2',
    conflictWith: 'c1',
    firstOverlapMs: 1500,
  });
  // 拒绝不产生写入
  assert.equal(out.resources.dev1.intervals.length, 1);
});

test('不重叠的相邻区间（左闭右开）成功提交', () => {
  const out = runInput({
    stream: [
      { type: 'occupy', id: 'c1', resource: 'dev1', startMs: 1000, endMs: 2000, baseVersion: 0 },
      { type: 'occupy', id: 'c2', resource: 'dev1', startMs: 2000, endMs: 3000, baseVersion: 0 },
      { type: 'occupy', id: 'c3', resource: 'dev1', startMs: 500, endMs: 1000, baseVersion: 0 },
    ],
  });
  assert.deepEqual(out.results.map((r) => r.status), ['committed', 'committed', 'committed']);
  assert.equal(out.resources.dev1.intervals.length, 3);
});

test('baseVersion 覆盖已提交区间后允许重叠写入；多资源互不影响', () => {
  const out = runInput({
    stream: [
      { type: 'occupy', id: 'c1', resource: 'dev1', startMs: 0, endMs: 100, baseVersion: 0 },
      { type: 'occupy', id: 'c2', resource: 'dev1', startMs: 50, endMs: 150, baseVersion: 1 },
      { type: 'occupy', id: 'c3', resource: 'dev2', startMs: 50, endMs: 150, baseVersion: 0 },
      { type: 'release', id: 'c4', resource: 'dev1', startMs: 60, endMs: 90, baseVersion: 2 },
      { type: 'override', id: 'c5', resource: 'dev1', startMs: 0, endMs: 60, baseVersion: 3, status: 'maintenance' },
    ],
  });
  assert.deepEqual(out.results.map((r) => r.status), [
    'committed', 'committed', 'committed', 'committed', 'committed',
  ]);
  const ivs = out.resources.dev1.intervals;
  // release 在 [60,90) 挖洞，override 将 [0,60) 覆盖为 maintenance
  assert.equal(ivs.filter((i) => i.status === 'maintenance').length, 1);
  assert.ok(ivs.every((i) => i.start < i.end));
  assert.ok(!ivs.some((i) => i.start < 90 && i.end > 60 && i.status !== 'maintenance' && i.start >= 60 && i.end <= 90));
});

test('区间反转（endMs <= startMs）报错', () => {
  const out = runInput({
    stream: [{ type: 'occupy', id: 'bad', resource: 'd', startMs: 100, endMs: 100, baseVersion: 0 }],
  });
  assert.equal(out.results[0].status, 'error');
  assert.equal(out.results[0].error, 'INTERVAL_INVERSION');
});
