import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimezoneTable } from '../src/timezone.js';
import { parseLocalToMs, formatUtcMs } from '../src/civil.js';
import { Engine } from '../src/engine.js';

const MIN = 60000;

// Acceptance 1: events around an explicit offset switch land on both sides
// of the switch boundary.
test('offset switch: events land on both sides of the boundary', () => {
  const tz = new TimezoneTable();
  const T0 = 1_700_000_000_000; // table epoch
  const T1 = T0 + 30 * 86400000; // switch instant (UTC)
  tz.defineZone('PLANT_A', [
    { atUtc: T0, offsetMinutes: 480 }, // UTC+8
    { atUtc: T1, offsetMinutes: 540 }, // UTC+9 from T1 on
  ]);

  // Local wall clock at the switch: old rule shows T1+8h, new rule T1+9h.
  // 1ms before the old-rule local switch instant -> still UTC+8 -> before T1.
  const beforeLocal = T1 + 480 * MIN - 1;
  const atLocal = T1 + 540 * MIN;       // first local instant of the new rule
  const afterLocal = T1 + 540 * MIN + 1;

  const beforeUtc = tz.localToUtc('PLANT_A', beforeLocal);
  const atUtc = tz.localToUtc('PLANT_A', atLocal);
  const afterUtc = tz.localToUtc('PLANT_A', afterLocal);

  assert.equal(beforeUtc, T1 - 1, 'event before switch maps before boundary');
  assert.equal(atUtc, T1, 'event at switch maps exactly to boundary');
  assert.equal(afterUtc, T1 + 1, 'event after switch maps after boundary');
  assert.ok(beforeUtc < T1 && afterUtc > T1, 'events straddle the boundary');
});

test('offset switch: merged interval boundary sits exactly at the switch instant', () => {
  const engine = new Engine();
  const T0 = 1_700_000_000_000;
  const T1 = T0 + 30 * 86400000;
  engine.handle({ type: 'defineZone', zone: 'PLANT_A', rules: [
    { atUtc: T0, offsetMinutes: 480 },
    { atUtc: T1, offsetMinutes: 540 },
  ] });
  // ON 1ms before the switch (local clock under old rule)...
  const onLocal = formatUtcMs(T1 + 480 * MIN - 1).replace('Z', '');
  // ...OFF exactly at the first local instant of the new rule.
  const offLocal = formatUtcMs(T1 + 540 * MIN).replace('Z', '');
  const r1 = engine.handle({ type: 'event', id: 'sw1', device: 'd-sw', zone: 'PLANT_A', state: 'ON', local: onLocal, version: 1 });
  const r2 = engine.handle({ type: 'event', id: 'sw2', device: 'd-sw', zone: 'PLANT_A', state: 'OFF', local: offLocal, version: 2 });
  assert.equal(r1.utcMs, T1 - 1);
  assert.equal(r2.utcMs, T1);
  const q = engine.handle({ type: 'query', device: 'd-sw', from: T1 - 10, to: T1 + 10 });
  assert.deepEqual(
    q.intervals.map(i => [i.state, i.start, i.end, i.status]),
    [['ON', T1 - 1, T1, 'CLOSED'], ['OFF', T1, T1 + 10, 'UNCLOSED']],
  );
});

// Acceptance 3a: illegal offset tables are errors.
test('illegal offset tables are rejected', () => {
  const tz = new TimezoneTable();
  assert.throws(
    () => tz.defineZone('Z1', [
      { atUtc: 1000, offsetMinutes: 480 },
      { atUtc: 1000, offsetMinutes: 540 }, // duplicate effective instant
    ]),
    /OFFSET_TABLE_CONFLICT/,
  );
  assert.throws(
    () => tz.defineZone('Z2', [
      { atUtc: 1_000_000, offsetMinutes: 540 },
      { atUtc: 1_000_001, offsetMinutes: -720 }, // local effective times go backwards
    ]),
    /OFFSET_TABLE_CONFLICT/,
  );
  assert.throws(
    () => tz.defineZone('Z3', [{ atUtc: 0, offsetMinutes: 900 }]), // > +14h
    /OFFSET_TABLE_CONFLICT/,
  );
  assert.throws(
    () => tz.defineZone('Z4', []),
    /OFFSET_TABLE_CONFLICT/,
  );
});

test('unknown timezone is an error', () => {
  const tz = new TimezoneTable();
  assert.throws(() => tz.localToUtc('NOWHERE', 0), /UNKNOWN_TIMEZONE/);
  const engine = new Engine();
  const out = engine.handleLine(JSON.stringify({
    type: 'event', id: 'x', device: 'd', zone: 'NOWHERE', state: 'ON', local: '2026-01-01T00:00:00',
  }));
  assert.equal(out.ok, false);
  assert.equal(out.code, 'UNKNOWN_TIMEZONE');
});

test('local time parsing is pure arithmetic (no system timezone)', () => {
  assert.equal(parseLocalToMs('1970-01-01T00:00:00.000'), 0);
  assert.equal(parseLocalToMs('1970-01-02T00:00:00'), 86400000);
  assert.equal(parseLocalToMs('2024-02-29T23:59:59.999'), parseLocalToMs('2024-03-01T00:00:00') - 1);
  assert.equal(formatUtcMs(0), '1970-01-01T00:00:00.000Z');
  assert.equal(formatUtcMs(parseLocalToMs('2026-03-08T02:30:00.500')), '2026-03-08T02:30:00.500Z');
});
