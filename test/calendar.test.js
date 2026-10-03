'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateCalendar } = require('../src/calendar');
const { buildTimezoneTables } = require('../src/timezone');
const { runInput } = require('../src/engine');

const D = 86400000;
const H = 3600000;

// 显式时区表：UTC+8 -> 第5天切 UTC+9:30（半时区）-> 第10天切回 UTC+8
const TZ_SPEC = {
  'Test/Zone': [
    { startUtcMs: 0, offsetMinutes: 480 },
    { startUtcMs: 5 * D, offsetMinutes: 570 },
    { startUtcMs: 10 * D, offsetMinutes: 480 },
  ],
};

test('零时长周期报错 ZERO_PERIOD', () => {
  const out = runInput({
    timezones: TZ_SPEC,
    calendar: { shifts: [{ id: 's0', resource: 'd', timezone: 'Test/Zone', anchorLocalMs: 0, periodMs: 0, durationMs: H }] },
    calendarWindow: { fromUtcMs: 0, toUtcMs: D },
    stream: [],
  });
  assert.equal(out.setupErrors.length, 1);
  assert.equal(out.setupErrors[0].error, 'ZERO_PERIOD');
});

test('交接区间反转报错 INTERVAL_INVERSION', () => {
  // 起点 UTC+8 本地 08:00，终点 UTC+9:30 本地 08:00 -> UTC 终点早于起点
  const out = runInput({
    timezones: TZ_SPEC,
    calendar: {
      handovers: [{
        id: 'h0', resource: 'd',
        startTimezone: 'Test/Zone', endTimezone: 'Test/Zone',
        startLocalMs: 8 * H, endLocalMs: 8 * H,
      }],
    },
    calendarWindow: { fromUtcMs: 0, toUtcMs: D },
    stream: [],
  });
  // 同一时区表内本地起=本地终，end<=start 必反转
  assert.equal(out.setupErrors[0].error, 'INTERVAL_INVERSION');
});

test('半时区交接区间：跨偏移表的本地起终点正确换算', () => {
  const tz = buildTimezoneTables({
    'A': [{ startUtcMs: 0, offsetMinutes: 480 }],   // UTC+8
    'B': [{ startUtcMs: 0, offsetMinutes: 570 }],   // UTC+9:30
  });
  const cal = generateCalendar({
    handovers: [{
      id: 'h1', resource: 'd',
      startTimezone: 'A', endTimezone: 'B',
      startLocalMs: 8 * H, endLocalMs: 10 * H,
    }],
  }, tz, 0, D);
  const [iv] = cal.get('d');
  assert.equal(iv.start, 0);            // 08:00 @ +8  = 00:00 UTC
  assert.equal(iv.end, 30 * 60000);     // 10:00 @ +9:30 = 00:30 UTC
  assert.equal(iv.status, 'handover');
});

test('停产例外从班次中减去对应区间', () => {
  const tz = buildTimezoneTables(TZ_SPEC);
  const cal = generateCalendar({
    shifts: [{ id: 's', resource: 'd', timezone: 'Test/Zone', anchorLocalMs: 0, periodMs: D, durationMs: 4 * H }],
    exceptions: [{ resource: 'd', startUtcMs: 17 * H, endUtcMs: 18 * H }],
  }, tz, 0, 2 * D);
  const ivs = cal.get('d');
  // 本地 00:00 @+8 => UTC 前一日 16:00；窗口内班次为 [16h,20h)，
  // 例外 [17h,18h) 将其切成 [16h,17h) 与 [18h,20h) 两段
  const cut = ivs.filter((i) => i.end === 17 * H || i.start === 18 * H);
  assert.equal(cut.length, 2);
  assert.ok(ivs.every((i) => i.end <= 17 * H || i.start >= 18 * H));
});
