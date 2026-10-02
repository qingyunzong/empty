'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, EngineError } = require('../src/engine');
const { computeWindows, isInWindow } = require('../src/windows');

function makeConfig(overrides = {}) {
  const engine = new Engine();
  engine.execute({
    cmd: 'configure',
    timezones: { 'Asia/Shanghai': 480, UTC: 0, ...overrides.timezones },
    rules: overrides.rules || [{
      id: 'qc-weekly',
      kind: 'weekly',
      weekday: 1, // Monday
      start: '08:00',
      durationMinutes: 480,
      timezone: 'Asia/Shanghai',
    }],
    holidays: overrides.holidays || { cancel: [], add: [] },
  });
  return engine.config;
}

test('weekly rule produces UTC windows via timezone table', () => {
  const config = makeConfig();
  const windows = computeWindows(config, Date.parse('2026-01-01T00:00:00Z'), Date.parse('2026-01-31T00:00:00Z'));
  // Mondays in Jan 2026: 5th, 12th, 19th, 26th; 08:00 CST == 00:00 UTC.
  assert.deepEqual(windows.map((w) => new Date(w.start).toISOString()), [
    '2026-01-05T00:00:00.000Z',
    '2026-01-12T00:00:00.000Z',
    '2026-01-19T00:00:00.000Z',
    '2026-01-26T00:00:00.000Z',
  ]);
  assert.equal(windows[0].end - windows[0].start, 480 * 60000);
  assert.equal(isInWindow(config, Date.parse('2026-01-05T02:00:00Z')), true);
  assert.equal(isInWindow(config, Date.parse('2026-01-06T02:00:00Z')), false);
  // Window is half-open: the end instant is outside.
  assert.equal(isInWindow(config, Date.parse('2026-01-05T08:00:00Z')), false);
});

test('holiday cancel removes a window, holiday add creates one', () => {
  const config = makeConfig({
    holidays: {
      cancel: ['2026-01-12'],
      add: [{ date: '2026-01-07', start: '09:00', durationMinutes: 60, timezone: 'Asia/Shanghai' }],
    },
  });
  const windows = computeWindows(config, Date.parse('2026-01-01T00:00:00Z'), Date.parse('2026-01-31T00:00:00Z'));
  const starts = windows.map((w) => new Date(w.start).toISOString());
  assert.ok(!starts.includes('2026-01-12T00:00:00.000Z'), 'cancelled window gone');
  assert.ok(starts.includes('2026-01-07T01:00:00.000Z'), 'added window present (09:00 CST)');
});

test('timezone offset segments shift the converted window', () => {
  const config = makeConfig({
    timezones: {
      'Test/Zone': [
        { from: '1970-01-01T00:00:00Z', offsetMinutes: 0 },
        { from: '2026-01-04T00:00:00Z', offsetMinutes: 120 },
      ],
    },
    rules: [{ id: 'r', kind: 'weekly', weekday: 1, start: '08:00', durationMinutes: 60, timezone: 'Test/Zone' }],
  });
  const windows = computeWindows(config, Date.parse('2025-12-01T00:00:00Z'), Date.parse('2026-01-31T00:00:00Z'));
  const byStart = new Map(windows.map((w) => [new Date(w.start).toISOString().slice(0, 10), w]));
  // Before offset change: Monday 08:00 local == 08:00 UTC.
  assert.equal(new Date(byStart.get('2025-12-29').start).toISOString(), '2025-12-29T08:00:00.000Z');
  // After offset change (+02:00): Monday 08:00 local == 06:00 UTC.
  assert.equal(new Date(byStart.get('2026-01-05').start).toISOString(), '2026-01-05T06:00:00.000Z');
});

test('illegal period rules are rejected with ILLEGAL_PERIOD', () => {
  const base = { id: 'r', kind: 'weekly', weekday: 1, start: '08:00', durationMinutes: 60, timezone: 'UTC' };
  const bad = [
    { ...base, kind: 'fortnightly' },
    { ...base, weekday: 7 },
    { ...base, weekday: -1 },
    { ...base, start: '25:00' },
    { ...base, start: '8:00' },
    { ...base, durationMinutes: 0 },
    { ...base, durationMinutes: -5 },
    { ...base, durationMinutes: 8 * 24 * 60 },
    { ...base, timezone: 'Nowhere' },
    { ...base, validFrom: '2026-02-01', validTo: '2026-01-01' },
  ];
  for (const rule of bad) {
    const engine = new Engine();
    assert.throws(
      () => engine.execute({ cmd: 'configure', timezones: { UTC: 0 }, rules: [rule], holidays: {} }),
      (err) => err instanceof EngineError && err.code === 'ILLEGAL_PERIOD',
      `expected ILLEGAL_PERIOD for ${JSON.stringify(rule)}`,
    );
  }
});
