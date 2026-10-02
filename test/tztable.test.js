import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTzTable, resolveLocal, offsetAtUtc } from '../src/tztable.js';
import { parseLocal, parseUtc } from '../src/civil.js';
import { tzdbRaw } from './helpers.js';

const tz = loadTzTable(tzdbRaw);
const L = parseLocal;

test('resolves ordinary local times to UTC', () => {
  assert.deepEqual(resolveLocal(tz, 'America/New_York', L('2024-06-10T11:00')), {
    utcMin: parseUtc('2024-06-10T15:00Z'),
    offsetMinutes: -240,
  });
  assert.deepEqual(resolveLocal(tz, 'Asia/Shanghai', L('2024-06-10T23:00')), {
    utcMin: parseUtc('2024-06-10T15:00Z'),
    offsetMinutes: 480,
  });
  assert.equal(resolveLocal(tz, 'America/New_York', L('2024-01-15T12:00')).offsetMinutes, -300);
});

test('spring-forward gap: nonexistent local times raise E_GAP', () => {
  for (const local of ['2024-03-10T02:00', '2024-03-10T02:30', '2024-03-10T02:59']) {
    assert.throws(() => resolveLocal(tz, 'America/New_York', L(local)), { code: 'E_GAP' }, local);
  }
  // London gap is 01:00-02:00 on 2024-03-31.
  assert.throws(() => resolveLocal(tz, 'Europe/London', L('2024-03-31T01:30')), { code: 'E_GAP' });
  // Minutes flanking the gap are fine.
  assert.equal(resolveLocal(tz, 'America/New_York', L('2024-03-10T01:59')).utcMin, parseUtc('2024-03-10T06:59Z'));
  assert.equal(resolveLocal(tz, 'America/New_York', L('2024-03-10T03:00')).utcMin, parseUtc('2024-03-10T07:00Z'));
});

test('fall-back overlap: ambiguous local times raise E_OVERLAP with both candidates', () => {
  let err;
  assert.throws(
    () => resolveLocal(tz, 'America/New_York', L('2024-11-03T01:30')),
    (e) => { err = e; return e.code === 'E_OVERLAP'; },
  );
  assert.equal(err.details.candidates.length, 2);
  assert.deepEqual(
    err.details.candidates.map((c) => c.utc),
    ['2024-11-03T05:30Z', '2024-11-03T06:30Z'],
  );
  assert.throws(() => resolveLocal(tz, 'Europe/London', L('2024-10-27T01:00')), { code: 'E_OVERLAP' });
  // Outside the repeated hour everything resolves normally.
  assert.equal(resolveLocal(tz, 'America/New_York', L('2024-11-03T00:59')).utcMin, parseUtc('2024-11-03T04:59Z'));
  assert.equal(resolveLocal(tz, 'America/New_York', L('2024-11-03T02:00')).utcMin, parseUtc('2024-11-03T07:00Z'));
});

test('unknown zone raises E_TZ_UNKNOWN', () => {
  assert.throws(() => resolveLocal(tz, 'Mars/Olympus', L('2024-06-10T12:00')), { code: 'E_TZ_UNKNOWN' });
});

test('table validation rejects malformed segments', () => {
  assert.throws(
    () => loadTzTable({ version: 'x', zones: { Z: { segments: [
      { utcStart: '2024-06-01T00:00Z', offsetMinutes: 0 },
      { utcStart: '2024-01-01T00:00Z', offsetMinutes: 60 },
    ] } } }),
    { code: 'E_INPUT' },
  );
  assert.throws(
    () => loadTzTable({ version: 'x', zones: { Z: { segments: [
      { utcStart: '2024-01-01T00:00Z', offsetMinutes: 0 },
      { utcStart: '2024-06-01T00:00Z', offsetMinutes: 0 },
    ] } } }),
    { code: 'E_INPUT' },
  );
  assert.throws(() => loadTzTable({ zones: {} }), { code: 'E_INPUT' });
});

test('offsetAtUtc picks the segment in effect', () => {
  assert.equal(offsetAtUtc(tz, 'America/New_York', parseUtc('2024-03-10T06:59Z')), -300);
  assert.equal(offsetAtUtc(tz, 'America/New_York', parseUtc('2024-03-10T07:00Z')), -240);
  assert.equal(offsetAtUtc(tz, 'Asia/Shanghai', parseUtc('2024-06-01T00:00Z')), 480);
});
