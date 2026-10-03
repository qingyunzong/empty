'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runCliText } = require('../src/cli');

test('CLI 读取 JSON 事务流并输出 JSON 结果', () => {
  const input = {
    stream: [
      { type: 'occupy', id: 'c1', resource: 'dev1', startMs: 0, endMs: 1000, baseVersion: 0 },
      { type: 'occupy', id: 'c2', resource: 'dev1', startMs: 500, endMs: 1500, baseVersion: 0 },
      { type: 'occupy', id: 'c3', resource: 'dev1', startMs: 1000, endMs: 2000, baseVersion: 0 },
    ],
  };
  const out = JSON.parse(runCliText(JSON.stringify(input)));
  assert.equal(out.results[0].status, 'committed');
  assert.equal(out.results[1].status, 'rejected');
  assert.deepEqual(out.results[1].certificate, {
    commandId: 'c2', conflictWith: 'c1', firstOverlapMs: 500,
  });
  assert.equal(out.results[2].status, 'committed');
  assert.equal(out.finalVersion, 2);
  assert.equal(out.resources.dev1.intervals.length, 2);
});

test('CLI 完整流程：日历物化 + 事务 + 冲突证书', () => {
  const D = 86400000;
  const out = JSON.parse(runCliText(JSON.stringify({
    timezones: { 'T': [{ startUtcMs: 0, offsetMinutes: 480 }] },
    calendar: {
      shifts: [{ id: 's', resource: 'dev', timezone: 'T', anchorLocalMs: 8 * 3600000, periodMs: D, durationMs: 3600000 }],
    },
    calendarWindow: { fromUtcMs: 0, toUtcMs: 2 * D },
    stream: [
      { type: 'begin', tx: 't1' },
      { type: 'override', id: 'm1', resource: 'dev', startMs: 0, endMs: 1800000, baseVersion: 0, status: 'maintenance' },
      { type: 'commit' },
      { type: 'release', id: 'r1', resource: 'dev', startMs: 0, endMs: 1000, baseVersion: 0 },
    ],
  })));
  assert.equal(out.results[1].status, 'committed');
  assert.equal(out.results[3].status, 'rejected'); // r1 与 m1 冲突
  assert.equal(out.results[3].certificate.conflictWith, 'm1');
  assert.equal(out.results[3].certificate.firstOverlapMs, 0);
  assert.ok(out.resources.dev.intervals.length >= 2);
});

test('CLI 非法 JSON 抛错', () => {
  assert.throws(() => runCliText('{not json'), /JSON/);
});
