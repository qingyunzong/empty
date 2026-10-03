'use strict';

// Acceptance 1: the same UTC instant falls into different merchant-local
// days under table v1 vs v2. Also: version registry semantics (E_TZVER).

const test = require('node:test');
const assert = require('node:assert/strict');
const { utcToLocal, TzRegistry, ReconError } = require('../src/index');
const { parseUtcIso } = require('../src/time');
const { ZONE, tableFixedPlus8, tableShifted, registryWith } = require('../testlib/helpers');

test('same UTC instant maps to different local days under v1 vs v2', () => {
  const reg = registryWith({ settlement: [tableFixedPlus8('v1'), tableShifted] });
  const utcMs = parseUtcIso('2024-06-01T16:30:00Z', null);

  const v1 = utcToLocal(reg.get('settlement', 'v1'), ZONE, utcMs);
  const v2 = utcToLocal(reg.get('settlement', 'v2'), ZONE, utcMs);

  assert.equal(v1.day, '2024-06-02'); // +8 -> 00:30 next day
  assert.equal(v2.day, '2024-06-01'); // +7 -> 23:30 same day
  assert.notEqual(v1.day, v2.day);
  assert.equal(v1.offsetMinutes, 480);
  assert.equal(v2.offsetMinutes, 420);
});

test('unknown pinned version raises E_TZVER', () => {
  const reg = registryWith({ txn: [tableFixedPlus8('v1')] });
  assert.throws(() => reg.get('txn', 'v9'), (e) => e instanceof ReconError && e.code === 'E_TZVER');
  assert.throws(() => reg.get('nope', 'v1'), (e) => e.code === 'E_TZVER');
});

test('registered versions are immutable: same version + different content -> E_TZVER', () => {
  const reg = new TzRegistry();
  reg.register('fee', tableFixedPlus8('v1'));
  // identical re-registration is an idempotent hot reload
  reg.register('fee', tableFixedPlus8('v1'));
  assert.throws(() => reg.register('fee', tableShifted && { ...tableShifted, version: 'v1' }),
    (e) => e.code === 'E_TZVER');
  // hot update works by registering a NEW version
  reg.register('fee', tableShifted);
  assert.deepEqual(reg.versions('fee').sort(), ['v1', 'v2']);
});

test('leap-style boundary requires explicit per-table mapping', () => {
  const withLeap = {
    version: 'leap1',
    zones: {
      [ZONE]: {
        transitions: [{ utc: '2020-01-01T00:00:00Z', offsetMinutes: 0 }],
        leapMap: { '2016-12-31T23:59:60Z': '2017-01-01T00:00:00Z' },
      },
    },
  };
  const reg = registryWith({ txn: [withLeap, tableFixedPlus8('v1')] });
  const leapMap = reg.get('txn', 'leap1').zones.get(ZONE).leapMap;
  const plainLeapMap = reg.get('txn', 'v1').zones.get(ZONE).leapMap;

  const mapped = parseUtcIso('2016-12-31T23:59:60Z', leapMap);
  assert.equal(mapped, parseUtcIso('2017-01-01T00:00:00Z', null));

  assert.throws(() => parseUtcIso('2016-12-31T23:59:60Z', plainLeapMap),
    (e) => e.code === 'E_TZVER');
});
