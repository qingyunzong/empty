'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionStore } = require('../src/index');

const T = (min) => new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString();
const up = (id, min, temp, version = 1, station = 's1') =>
  ({ op: 'UPSERT', id, station, eventTime: T(min), temp, version });

test('乱序插入导致两个会话合并为一个', () => {
  const s = new SessionStore();
  // 00:00 与 00:12 间隔 12 分钟 > 10，本属两个会话
  assert.deepEqual(s.upsert(up('a', 0, 10)), { ok: true, changed: true });
  assert.deepEqual(s.upsert(up('c', 12, 20)), { ok: true, changed: true });
  // 乱序补入 00:06，桥接两端 -> 合并
  assert.deepEqual(s.upsert(up('b', 6, 15)), { ok: true, changed: true });

  const out = s.watermark(T(30));
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    station: 's1',
    start: T(0),
    end: T(12),
    count: 3,
    avgTemp: 15,
    ids: ['a', 'b', 'c'],
    version: 1,
  });
});

test('最终化前撤回中间点导致会话分裂', () => {
  const s = new SessionStore();
  s.upsert(up('a', 0, 10));
  s.upsert(up('b', 6, 20));
  s.upsert(up('c', 12, 30));
  // 三点间隔 6 分钟，同一会话；撤回中间点 b 后间隔变 12 分钟 -> 分裂
  assert.deepEqual(s.retract({ op: 'RETRACT', id: 'b', version: 1 }), { ok: true, changed: true });

  const out = s.watermark(T(30));
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    station: 's1', start: T(0), end: T(0), count: 1, avgTemp: 10, ids: ['a'], version: 1,
  });
  assert.deepEqual(out[1], {
    station: 's1', start: T(12), end: T(12), count: 1, avgTemp: 30, ids: ['c'], version: 1,
  });
});

test('迟到记录与未知撤回报错且状态不变', () => {
  const s = new SessionStore();
  s.upsert(up('a', 0, 10));
  s.upsert(up('b', 5, 20));
  const first = s.watermark(T(20)); // 00:05 + 10min < 00:20 -> 最终化
  assert.equal(first.length, 1);
  assert.equal(first[0].count, 2);

  // 迟到 UPSERT
  assert.deepEqual(s.upsert(up('late', 3, 99)), { ok: false, error: 'LATE' });
  // 撤回已最终化的观测 -> LATE
  assert.deepEqual(s.retract({ op: 'RETRACT', id: 'a', version: 1 }), { ok: false, error: 'LATE' });
  // 撤回未知 ID
  assert.deepEqual(s.retract({ op: 'RETRACT', id: 'ghost', version: 1 }), { ok: false, error: 'UNKNOWN_RETRACT' });

  // 状态不变：再次推进水位线不产生任何新会话
  assert.deepEqual(s.watermark(T(120)), []);
});

test('幂等、版本回退与重复撤回', () => {
  const s = new SessionStore();
  assert.deepEqual(s.upsert(up('a', 0, 10, 2)), { ok: true, changed: true });
  // 同 ID 同版本幂等
  assert.deepEqual(s.upsert(up('a', 0, 999, 2)), { ok: true, changed: false });
  // 版本回退
  assert.deepEqual(s.upsert(up('a', 0, 10, 1)), { ok: false, error: 'STALE_VERSION' });
  // 撤回未知 ID
  assert.deepEqual(s.retract({ op: 'RETRACT', id: 'nope', version: 1 }), { ok: false, error: 'UNKNOWN_RETRACT' });
  // 正常撤回，重复撤回幂等
  assert.deepEqual(s.retract({ op: 'RETRACT', id: 'a', version: 2 }), { ok: true, changed: true });
  assert.deepEqual(s.retract({ op: 'RETRACT', id: 'a', version: 2 }), { ok: true, changed: false });
  // 撤回后版本回退仍报 STALE_VERSION
  assert.deepEqual(s.upsert(up('a', 0, 10, 1)), { ok: false, error: 'STALE_VERSION' });

  assert.deepEqual(s.watermark(T(30)), []);
});

test('间隔恰好 10 分钟合并，超过则断开；水位线边界严格大于', () => {
  const s = new SessionStore();
  s.upsert(up('a', 0, 10));
  s.upsert(up('b', 10, 20)); // 恰好 10 分钟 -> 同一会话
  s.upsert(up('c', 21, 30)); // 11 分钟 -> 新会话

  // 会话 [a,b] 最大事件时间 00:10，水位线 00:20 不严格大于 -> 不最终化
  assert.deepEqual(s.watermark(T(20)), []);
  const out = s.watermark(new Date(Date.UTC(2026, 0, 1, 0, 20, 0, 1)).toISOString());
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].ids, ['a', 'b']);
  // 会话 [c] 最大事件时间 00:21 + 10min = 00:31
  const out2 = s.watermark(T(32));
  assert.equal(out2.length, 1);
  assert.deepEqual(out2[0].ids, ['c']);
});

test('多站点互不影响，会话版本号取成员最大版本', () => {
  const s = new SessionStore();
  s.upsert(up('a', 0, 10, 1, 's1'));
  s.upsert(up('b', 5, 20, 3, 's1'));
  s.upsert(up('x', 1, 1, 1, 's2'));
  const out = s.watermark(T(30));
  assert.equal(out.length, 2);
  assert.equal(out[0].station, 's1');
  assert.equal(out[0].version, 3);
  assert.equal(out[1].station, 's2');
  assert.equal(out[1].version, 1);
});
