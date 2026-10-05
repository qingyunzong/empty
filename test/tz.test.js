import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TzTable } from '../lib/tz.js';
import { ClearingError, E } from '../lib/errors.js';
import { parseLocalMinutes, parseUtcMinutes } from '../lib/time.js';
import { TZ } from './helpers.js';

const tz = new TzTable(TZ);

test('fixed offset zone converts both ways', () => {
  const utc = parseUtcMinutes('2024-06-10T00:00:00Z');
  assert.equal(tz.utcToLocal('Asia/Shanghai', utc), utc + 480);
  assert.equal(tz.localToUtc('Asia/Shanghai', utc + 480), utc);
});

test('spring-forward gap: local 2024-03-10T02:30 in New York does not exist', () => {
  const local = parseLocalMinutes('2024-03-10T02:30');
  assert.throws(
    () => tz.localToUtc('America/New_York', local),
    (err) => err instanceof ClearingError && err.code === E.GAP,
  );
});

test('fall-back overlap: local 2024-11-03T01:30 in New York is ambiguous', () => {
  const local = parseLocalMinutes('2024-11-03T01:30');
  const candidates = tz.localToUtcCandidates('America/New_York', local);
  assert.equal(candidates.length, 2);
  assert.throws(
    () => tz.localToUtc('America/New_York', local),
    (err) => err instanceof ClearingError && err.code === E.OVERLAP,
  );
});

test('minutes adjacent to the gap resolve exactly', () => {
  // 01:59 EST -> 06:59Z, 03:00 EDT -> 07:00Z
  assert.equal(tz.localToUtc('America/New_York', parseLocalMinutes('2024-03-10T01:59')), parseUtcMinutes('2024-03-10T06:59Z'));
  assert.equal(tz.localToUtc('America/New_York', parseLocalMinutes('2024-03-10T03:00')), parseUtcMinutes('2024-03-10T07:00Z'));
});

test('unknown zone and uncovered range raise E_TZ_UNKNOWN', () => {
  assert.throws(() => tz.utcToLocal('Mars/Olympus', 0), (err) => err.code === E.TZ_UNKNOWN);
  assert.throws(() => tz.utcToLocal('Asia/Shanghai', -1), (err) => err.code === E.TZ_UNKNOWN);
});

test('london overlap has two candidates one hour apart', () => {
  const candidates = tz.localToUtcCandidates('Europe/London', parseLocalMinutes('2024-10-27T01:30'));
  assert.equal(candidates.length, 2);
  assert.equal(candidates[1] - candidates[0], 60);
});
