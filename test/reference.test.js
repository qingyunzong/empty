'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, referenceMerged } = require('../src/index');

function iso(ms) {
  return new Date(ms).toISOString();
}

function local(ms) {
  return iso(ms).slice(0, 23);
}

// Deterministic PRNG (LCG) so the fuzz run is reproducible offline.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
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

test('optimized sweep matches per-millisecond reference on randomized scenarios', () => {
  const rand = lcg(0xC0FFEE);
  const ITERATIONS = 40;

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const engine = new Engine();
    engine.execute({
      cmd: 'defineZone',
      zone: 'utc',
      offsets: [{ effectiveFromUtc: '1960-01-01T00:00:00.000Z', offsetMinutes: 0 }],
    });

    const obsStart = 0;
    const cutoff = 30000 + Math.floor(rand() * 60000);

    if (rand() < 0.8) {
      const start = Math.floor(rand() * 5000);
      const duration = 500 + Math.floor(rand() * 3000);
      const end = start + duration * (2 + Math.floor(rand() * 30));
      engine.execute({ cmd: 'definePeriods', startUtc: iso(start), durationMs: duration, endUtc: iso(end) });
    }

    const silenceCount = Math.floor(rand() * 3);
    for (let i = 0; i < silenceCount; i++) {
      const s = Math.floor(rand() * cutoff * 0.8);
      const e = s + 1000 + Math.floor(rand() * (cutoff - s - 1000));
      engine.execute({ cmd: 'defineSilence', startUtc: iso(s), endUtc: iso(e) });
    }

    // Random events with occasional replaces and voids.
    const eventCount = 3 + Math.floor(rand() * 25);
    const ids = [];
    let maxVersion = 1;
    for (let i = 0; i < eventCount; i++) {
      const id = `ev-${iter}-${i}`;
      ids.push(id);
      const t = Math.floor(rand() * (cutoff + 5000)) - 2000; // some outside observation
      engine.execute({
        cmd: 'event',
        event: {
          id,
          deviceId: 'dev-fuzz',
          state: rand() < 0.5 ? 'ON' : 'OFF',
          zone: 'utc',
          localTime: local(t),
          version: 1,
        },
      });
      if (rand() < 0.3) {
        maxVersion += 1;
        const t2 = Math.floor(rand() * (cutoff + 5000)) - 2000;
        engine.execute({
          cmd: 'replace',
          id,
          event: {
            deviceId: 'dev-fuzz',
            state: rand() < 0.5 ? 'ON' : 'OFF',
            zone: 'utc',
            localTime: local(t2),
            version: maxVersion,
          },
        });
      }
      if (rand() < 0.15) {
        maxVersion += 1;
        engine.execute({ cmd: 'void', id, version: maxVersion });
      }
    }

    const observation = { startUtc: iso(obsStart), cutoffUtc: iso(cutoff) };
    const versionsToCheck = [null];
    for (let v = 1; v <= maxVersion; v++) versionsToCheck.push(v);

    for (const upToVersion of versionsToCheck) {
      const cmd = { cmd: 'merge', deviceId: 'dev-fuzz', observation };
      if (upToVersion !== null) cmd.upToVersion = upToVersion;
      const merged = engine.execute(cmd);
      const reference = referenceMerged({
        events: engine.effectiveEvents('dev-fuzz', upToVersion === null ? undefined : upToVersion),
        periods: engine.periods,
        silences: engine.silences,
        obsStart,
        cutoff,
      }).map((iv) => ({ ...iv, unclosed: iv.endUtcMs === cutoff }));
      assert.deepEqual(
        slim(merged.intervals),
        slim(reference),
        `iteration ${iter}, upToVersion ${upToVersion}: sweep must match per-ms reference`
      );
    }
  }
});

test('millisecond-level duplicate events merge into one interval', () => {
  const engine = new Engine();
  engine.execute({ cmd: 'defineZone', zone: 'utc', offsets: [{ effectiveFromUtc: '2020-01-01T00:00:00.000Z', offsetMinutes: 0 }] });
  const T0 = Date.UTC(2026, 5, 1, 0, 0, 0);
  // Three events at the same millisecond: two ON duplicates and a later-version OFF.
  engine.execute({ cmd: 'event', event: { id: 'd1', deviceId: 'dev-dup', state: 'ON', zone: 'utc', localTime: local(T0 + 500), version: 1 } });
  engine.execute({ cmd: 'event', event: { id: 'd2', deviceId: 'dev-dup', state: 'ON', zone: 'utc', localTime: local(T0 + 500), version: 1 } });
  engine.execute({ cmd: 'event', event: { id: 'd3', deviceId: 'dev-dup', state: 'OFF', zone: 'utc', localTime: local(T0 + 500), version: 2 } });
  engine.execute({ cmd: 'event', event: { id: 'd4', deviceId: 'dev-dup', state: 'ON', zone: 'utc', localTime: local(T0 + 900), version: 1 } });

  const merged = engine.execute({
    cmd: 'merge',
    deviceId: 'dev-dup',
    observation: { startUtc: iso(T0), cutoffUtc: iso(T0 + 2000) },
  });
  // Highest version at the shared millisecond wins: OFF at +500, then ON at +900.
  assert.deepEqual(
    merged.intervals.map((iv) => [iv.state, iv.startUtcMs - T0, iv.endUtcMs - T0]),
    [
      ['OFF', 500, 900],
      ['ON', 900, 2000],
    ]
  );
  // The certificate still records every original id, including the duplicates.
  const allIds = merged.certificate.intervals.flatMap((iv) => iv.mergedEventIds).sort();
  assert.deepEqual(allIds, ['d1', 'd2', 'd3', 'd4']);
});
