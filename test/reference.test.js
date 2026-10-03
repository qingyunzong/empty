'use strict';

// 验收 3：偏移切换夜的周期边界。
// 用“枚举所有区间相交组合”的朴素参考算法，与库实现交叉校验。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateCalendar } = require('../src/calendar');
const { buildTimezoneTables } = require('../src/timezone');
const { overlaps, firstOverlapMs } = require('../src/intervals');

const D = 86400000;
const H = 3600000;
const MIN = 60000;

// 时区表：UTC+8，第5天 18:00 UTC 跳进为 UTC+9:30（半时区），第10天 12:00 UTC 回拨
const TZ_SPEC = {
  'Test/Zone': [
    { startUtcMs: 0, offsetMinutes: 480 },
    { startUtcMs: 5 * D + 18 * H, offsetMinutes: 570 },
    { startUtcMs: 10 * D + 12 * H, offsetMinutes: 480 },
  ],
};
const WINDOW = { fromUtcMs: 0, toUtcMs: 15 * D };

// ---- 参考实现：刻意独立、朴素 ----

function refUtcFromLocal(entries, localMs) {
  let chosen = entries[0];
  for (const e of entries) {
    if (localMs >= e.startUtcMs + e.offsetMinutes * MIN) chosen = e;
  }
  return localMs - chosen.offsetMinutes * MIN;
}

function refGenerate() {
  const entries = TZ_SPEC['Test/Zone'];
  const out = [];
  // 每日 23:30 本地、2 小时的班次，朴素枚举 k
  const anchor = 23.5 * H;
  for (let k = -100; k <= 100; k++) {
    const localStart = anchor + k * D;
    const start = refUtcFromLocal(entries, localStart);
    const end = start + 2 * H;
    if (end <= WINDOW.fromUtcMs || start >= WINDOW.toUtcMs) continue;
    out.push({ start, end });
  }
  // 一个跨切换夜的交接区间：本地 5D+22:00(+8) 到本地 6D+04:00(+9:30)
  const hs = refUtcFromLocal(entries, 5 * D + 22 * H);
  const he = refUtcFromLocal(entries, 6 * D + 4 * H);
  out.push({ start: hs, end: he });
  out.sort((a, b) => a.start - b.start);
  return out;
}

// 朴素参考：枚举所有区间对 (i<j)，收集相交组合
function refAllIntersections(ivs) {
  const pairs = [];
  for (let i = 0; i < ivs.length; i++) {
    for (let j = i + 1; j < ivs.length; j++) {
      const a = ivs[i];
      const b = ivs[j];
      if (a.start < b.end && b.start < a.end) {
        pairs.push({ i, j, firstMs: Math.max(a.start, b.start) });
      }
    }
  }
  return pairs;
}

// 被校验的扫描线实现：按 start 排序后只向后扫描
function sweepIntersections(ivs) {
  const pairs = [];
  for (let i = 0; i < ivs.length; i++) {
    for (let j = i + 1; j < ivs.length && ivs[j].start < ivs[i].end; j++) {
      if (overlaps(ivs[i].start, ivs[i].end, ivs[j].start, ivs[j].end)) {
        pairs.push({ i, j, firstMs: firstOverlapMs(ivs[i].start, ivs[i].end, ivs[j].start, ivs[j].end) });
      }
    }
  }
  return pairs;
}

test('偏移切换夜的周期边界与参考算法一致', () => {
  const tz = buildTimezoneTables(TZ_SPEC);
  const lib = generateCalendar({
    shifts: [{
      id: 'night', resource: 'dev', timezone: 'Test/Zone',
      anchorLocalMs: 23.5 * H, periodMs: D, durationMs: 2 * H,
    }],
    handovers: [{
      id: 'ho', resource: 'dev',
      startTimezone: 'Test/Zone', endTimezone: 'Test/Zone',
      startLocalMs: 5 * D + 22 * H, endLocalMs: 6 * D + 4 * H,
    }],
  }, tz, WINDOW.fromUtcMs, WINDOW.toUtcMs).get('dev');

  const ref = refGenerate();

  // 1) 物化区间逐一相等（数量、起止毫秒）
  assert.equal(lib.length, ref.length);
  for (let i = 0; i < lib.length; i++) {
    assert.equal(lib[i].start, ref[i].start, `interval ${i} start`);
    assert.equal(lib[i].end, ref[i].end, `interval ${i} end`);
  }

  // 2) 切换夜的具体边界：切换生效于第5天 18:00 UTC（= 旧本地第6天 02:00）。
  //    本地第5天夜班仍在 +8，本地第6天夜班落入 +9:30，UTC 起点提前 90 分钟。
  const nights = lib.filter((i) => i.source === 'night');
  const day5 = nights.find((i) => i.start >= 5 * D && i.start < 6 * D);
  const day6 = nights.find((i) => i.start >= 6 * D && i.start < 7 * D);
  assert.equal(day5.start - 5 * D, 15.5 * H);        // 23:30 - 8h（旧偏移）
  assert.equal(day6.start - 6 * D, 14 * H);          // 23:30 - 9.5h（新偏移）
  assert.equal(day6.start - day5.start, D - 1.5 * H); // 提前 90 分钟
  assert.equal(day6.end - day6.start, 2 * H);        // 绝对时长不变

  // 3) 所有区间相交组合：扫描线实现与朴素枚举完全一致
  const plain = refAllIntersections(lib);
  const swept = sweepIntersections(lib);
  assert.deepEqual(swept, plain);
  assert.ok(plain.length > 0, '交接区间应与切换夜班次相交');
  for (const p of plain) {
    assert.ok(p.firstMs >= 0);
  }
});
