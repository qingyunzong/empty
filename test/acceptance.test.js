'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, MergeError, referenceMerged } = require('../src/index');

function iso(ms) {
  return new Date(ms).toISOString();
}

function slim(intervals) {
  return intervals.map((iv) => ({
    state: iv.state,
    scope: iv.scope,
    startUtcMs: iv.startUtcMs,
    endUtcMs: iv.endUtcMs,
    unclosed: iv.unclosed,
  }));
}

test('acceptance 1: events land on both sides of an offset switch', () => {
  const engine = new Engine();
  // Fictional plant zone: UTC+8 until 2026-03-01T00:00:00Z, then UTC+9.
  const switchMs = Date.UTC(2026, 2, 1, 0, 0, 0);
  engine.execute({
    cmd: 'defineZone',
    zone: 'plant-x',
    offsets: [
      { effectiveFromUtc: '2026-01-01T00:00:00.000Z', offsetMinutes: 480 },
      { effectiveFromUtc: '2026-03-01T00:00:00.000Z', offsetMinutes: 540 },
    ],
  });

  // Local 2026-02-28T16:30 under +8 -> 2026-02-28T08:30Z (before the switch).
  const before = engine.execute({
    cmd: 'event',
    event: { id: 'sw-on', deviceId: 'dev-1', state: 'ON', zone: 'plant-x', localTime: '2026-02-28T16:30:00.000' },
  });
  assert.equal(before.utcMs, Date.UTC(2026, 1, 28, 8, 30, 0));
  assert.ok(before.utcMs < switchMs, 'event before switch must convert with the old offset');

  // Local 2026-03-01T09:30 under +9 -> 2026-03-01T00:30Z (after the switch).
  const after = engine.execute({
    cmd: 'event',
    event: { id: 'sw-off', deviceId: 'dev-1', state: 'OFF', zone: 'plant-x', localTime: '2026-03-01T09:30:00.000' },
  });
  assert.equal(after.utcMs, Date.UTC(2026, 2, 1, 0, 30, 0));
  assert.ok(after.utcMs > switchMs, 'event after switch must convert with the new offset');

  // The two local times are 17h apart on the wall clock but only 16h apart in
  // UTC: the offset switch absorbed exactly one hour.
  assert.equal(after.utcMs - before.utcMs, 16 * 3600 * 1000);

  // Local times inside the skipped hour do not exist.
  assert.throws(
    () => engine.execute({
      cmd: 'event',
      event: { id: 'sw-gap', deviceId: 'dev-1', state: 'ON', zone: 'plant-x', localTime: '2026-03-01T08:30:00.000' },
    }),
    (err) => err instanceof MergeError && err.code === 'LOCAL_TIME_INVALID'
  );

  // The merged ON interval crosses the switch instant with exact UTC bounds.
  const merged = engine.execute({
    cmd: 'merge',
    deviceId: 'dev-1',
    observation: { startUtc: '2026-02-28T00:00:00.000Z', cutoffUtc: '2026-03-02T00:00:00.000Z' },
  });
  const on = merged.intervals.find((iv) => iv.state === 'ON');
  assert.equal(on.startUtcMs, Date.UTC(2026, 1, 28, 8, 30, 0));
  assert.equal(on.endUtcMs, Date.UTC(2026, 2, 1, 0, 30, 0));
  assert.ok(on.startUtcMs < switchMs && on.endUtcMs > switchMs);
});

test('acceptance 2: late correction changes a three-period merge; void and replay work', () => {
  const engine = new Engine();
  const T0 = Date.UTC(2026, 0, 10, 0, 0, 0);
  engine.execute({
    cmd: 'defineZone',
    zone: 'utc',
    offsets: [{ effectiveFromUtc: '2020-01-01T00:00:00.000Z', offsetMinutes: 0 }],
  });
  // Three 60s periods, all inside one maintenance silence.
  engine.execute({ cmd: 'definePeriods', startUtc: iso(T0), durationMs: 60000, endUtc: iso(T0 + 180000) });
  engine.execute({ cmd: 'defineSilence', startUtc: iso(T0), endUtc: iso(T0 + 180000) });

  engine.execute({ cmd: 'event', event: { id: 'e1', deviceId: 'dev-2', state: 'ON', zone: 'utc', localTime: iso(T0 + 1000).slice(0, 23), version: 1 } });
  engine.execute({ cmd: 'event', event: { id: 'e2', deviceId: 'dev-2', state: 'OFF', zone: 'utc', localTime: iso(T0 + 170000).slice(0, 23), version: 1 } });

  const observation = { startUtc: iso(T0), cutoffUtc: iso(T0 + 180000) };
  const merge1 = engine.execute({ cmd: 'merge', deviceId: 'dev-2', observation });

  // Same state across all three periods inside one silence -> a single ON
  // interval spanning the three period windows.
  assert.equal(merge1.intervals.length, 2);
  assert.equal(merge1.intervals[0].state, 'ON');
  assert.equal(merge1.intervals[0].startUtcMs, T0 + 1000);
  assert.equal(merge1.intervals[0].endUtcMs, T0 + 170000);
  assert.ok(merge1.intervals[0].startUtcMs < T0 + 60000 && merge1.intervals[0].endUtcMs > T0 + 120000,
    'ON interval must span all three period windows');
  assert.equal(merge1.intervals[1].state, 'OFF');
  assert.equal(merge1.intervals[1].unclosed, true);

  // Late corrections: the OFF actually happened at +61s (replace, v2) and a
  // previously unknown ON arrived late at +119s (v3).
  engine.execute({ cmd: 'replace', id: 'e2', event: { deviceId: 'dev-2', state: 'OFF', zone: 'utc', localTime: iso(T0 + 61000).slice(0, 23), version: 2 } });
  engine.execute({ cmd: 'event', event: { id: 'e3', deviceId: 'dev-2', state: 'ON', zone: 'utc', localTime: iso(T0 + 119000).slice(0, 23), version: 3 } });

  const merge2 = engine.execute({ cmd: 'merge', deviceId: 'dev-2', observation });
  assert.deepEqual(
    merge2.intervals.map((iv) => [iv.state, iv.startUtcMs - T0, iv.endUtcMs - T0, iv.unclosed]),
    [
      ['ON', 1000, 61000, false],
      ['OFF', 61000, 119000, false],
      ['ON', 119000, 180000, true],
    ],
    'the single three-period merge must split after the correction'
  );

  // Affected range covers the corrected region; certificate lists original
  // ids and the timeline of merged events.
  assert.ok(merge2.affectedRange, 'correction must produce an affected range');
  assert.ok(merge2.affectedRange.fromUtcMs <= T0 + 61000);
  assert.ok(merge2.affectedRange.toUtcMs >= T0 + 119000);
  const allIds = merge2.certificate.intervals.flatMap((iv) => iv.mergedEventIds);
  assert.deepEqual(allIds.sort(), ['e1', 'e2', 'e3']);
  const e2entry = merge2.certificate.intervals.flatMap((iv) => iv.timeline).find((t) => t.id === 'e2');
  assert.equal(e2entry.version, 2);
  assert.equal(e2entry.utcMs, T0 + 61000);

  // Void the late ON (v4): the OFF interval becomes unclosed to the cutoff.
  engine.execute({ cmd: 'void', id: 'e3', version: 4 });
  const merge3 = engine.execute({ cmd: 'merge', deviceId: 'dev-2', observation });
  assert.deepEqual(
    merge3.intervals.map((iv) => [iv.state, iv.startUtcMs - T0, iv.endUtcMs - T0, iv.unclosed]),
    [
      ['ON', 1000, 61000, false],
      ['OFF', 61000, 180000, true],
    ]
  );

  // Replay by version: v3 restores merge2, v1 restores the original merge1.
  const replay3 = engine.execute({ cmd: 'merge', deviceId: 'dev-2', observation, upToVersion: 3 });
  assert.deepEqual(slim(replay3.intervals), slim(merge2.intervals));
  const replay1 = engine.execute({ cmd: 'merge', deviceId: 'dev-2', observation, upToVersion: 1 });
  assert.deepEqual(slim(replay1.intervals), slim(merge1.intervals));
});

test('acceptance 3: illegal offset table, unknown zone, inverted periods, open interval vs reference', () => {
  const engine = new Engine();

  // Illegal offset tables -> OFFSET_TABLE_CONFLICT.
  for (const offsets of [
    // duplicate effective instant
    [
      { effectiveFromUtc: '2026-01-01T00:00:00.000Z', offsetMinutes: 480 },
      { effectiveFromUtc: '2026-01-01T00:00:00.000Z', offsetMinutes: 540 },
    ],
    // decreasing effective instants
    [
      { effectiveFromUtc: '2026-06-01T00:00:00.000Z', offsetMinutes: 480 },
      { effectiveFromUtc: '2026-01-01T00:00:00.000Z', offsetMinutes: 540 },
    ],
    // offset out of range
    [{ effectiveFromUtc: '2026-01-01T00:00:00.000Z', offsetMinutes: 2000 }],
    // empty table
    [],
  ]) {
    assert.throws(
      () => engine.execute({ cmd: 'defineZone', zone: 'bad', offsets }),
      (err) => err instanceof MergeError && err.code === 'OFFSET_TABLE_CONFLICT'
    );
  }

  // Unknown zone -> UNKNOWN_ZONE.
  assert.throws(
    () => engine.execute({
      cmd: 'event',
      event: { id: 'x1', deviceId: 'dev-3', state: 'ON', zone: 'nowhere', localTime: '2026-01-01T00:00:00.000' },
    }),
    (err) => err instanceof MergeError && err.code === 'UNKNOWN_ZONE'
  );

  // Inverted periods -> PERIOD_INVERTED.
  assert.throws(
    () => engine.execute({ cmd: 'definePeriods', startUtc: '2026-01-01T00:00:00.000Z', durationMs: 0, endUtc: '2026-01-02T00:00:00.000Z' }),
    (err) => err instanceof MergeError && err.code === 'PERIOD_INVERTED'
  );
  assert.throws(
    () => engine.execute({ cmd: 'definePeriods', startUtc: '2026-01-02T00:00:00.000Z', durationMs: 1000, endUtc: '2026-01-01T00:00:00.000Z' }),
    (err) => err instanceof MergeError && err.code === 'PERIOD_INVERTED'
  );

  // Open interval: an ON without a closing OFF is NOT an error; it produces
  // an interval up to the observation cutoff flagged UNCLOSED.
  const T0 = Date.UTC(2026, 3, 1, 0, 0, 0);
  engine.execute({ cmd: 'defineZone', zone: 'utc', offsets: [{ effectiveFromUtc: '2020-01-01T00:00:00.000Z', offsetMinutes: 0 }] });
  engine.execute({ cmd: 'definePeriods', startUtc: iso(T0), durationMs: 1000, endUtc: iso(T0 + 60000) });
  engine.execute({ cmd: 'defineSilence', startUtc: iso(T0 + 5000), endUtc: iso(T0 + 25000) });
  engine.execute({ cmd: 'event', event: { id: 'open-1', deviceId: 'dev-3', state: 'ON', zone: 'utc', localTime: iso(T0 + 2500).slice(0, 23) } });

  const observation = { startUtc: iso(T0), cutoffUtc: iso(T0 + 60000) };
  const merged = engine.execute({ cmd: 'merge', deviceId: 'dev-3', observation });
  assert.equal(merged.type, 'mergeResult');
  const last = merged.intervals[merged.intervals.length - 1];
  assert.equal(last.state, 'ON');
  assert.equal(last.endUtcMs, T0 + 60000, 'open interval must extend to the observation cutoff');
  assert.equal(last.unclosed, true, 'open interval must be flagged UNCLOSED');

  // Cross-check the optimized sweep against per-millisecond enumeration.
  const reference = referenceMerged({
    events: engine.effectiveEvents('dev-3'),
    periods: engine.periods,
    silences: engine.silences,
    obsStart: T0,
    cutoff: T0 + 60000,
  }).map((iv) => ({ ...iv, unclosed: iv.endUtcMs === T0 + 60000 }));
  assert.deepEqual(slim(merged.intervals), slim(reference));
});
