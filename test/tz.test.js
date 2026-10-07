'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TzRegistry,
  utcToLocal,
  localToUtc,
  localCandidates,
  ReconError,
  CODES,
} = require('../index');

const DAY = 86400;
const EPOCH_2024 = Date.UTC(2024, 0, 1) / 1000;

function loadExamples() {
  const registry = new TzRegistry();
  registry.load(require('../examples/tz-v1.json'));
  registry.load(require('../examples/tz-v2.json'));
  return registry;
}

test('acceptance 1: same UTC instant falls into different local days under v1 vs v2', () => {
  const registry = loadExamples();
  const utc = '2024-06-15T16:30:00Z';
  const v1 = utcToLocal(utc, registry.get('v1'));
  const v2 = utcToLocal(utc, registry.get('v2'));
  assert.equal(v1.localDay, '2024-06-16'); // +08:00
  assert.equal(v2.localDay, '2024-06-15'); // +07:00 after 2024-06-01
  assert.notEqual(v1.localDay, v2.localDay);
  // Before the v2 rule change both versions agree.
  const early = '2024-03-15T16:30:00Z';
  assert.equal(utcToLocal(early, registry.get('v1')).localDay, utcToLocal(early, registry.get('v2')).localDay);
});

function foldTable() {
  // Offset +02:00 until 2024-10-27T01:00:00Z, then +01:00: local 02:00-03:00 repeats.
  return {
    version: 'fold',
    segments: [
      { utcStart: '2024-01-01T00:00:00Z', utcEnd: '2024-10-27T01:00:00Z', offsetSeconds: 7200 },
      { utcStart: '2024-10-27T01:00:00Z', utcEnd: '2025-01-01T00:00:00Z', offsetSeconds: 3600 },
    ],
  };
}

function gapTable() {
  // Offset +01:00 until 2024-03-31T01:00:00Z, then +02:00: local 02:00-03:00 never happens.
  return {
    version: 'gap',
    segments: [
      { utcStart: '2024-01-01T00:00:00Z', utcEnd: '2024-03-31T01:00:00Z', offsetSeconds: 3600 },
      { utcStart: '2024-03-31T01:00:00Z', utcEnd: '2025-01-01T00:00:00Z', offsetSeconds: 7200 },
    ],
  };
}

test('acceptance 2: ambiguous local time - strict/earlier/later are deterministic and reproducible', () => {
  const registry = new TzRegistry();
  const table = registry.load(foldTable());
  const local = '2024-10-27T02:30:00';

  const candidates = localCandidates(local, table);
  assert.equal(candidates.length, 2);

  assert.throws(() => localToUtc(local, table, 'strict'), (err) => {
    assert.equal(err.code, CODES.AMBIG);
    assert.equal(err.details.kind, 'ambiguous');
    return true;
  });

  const civil = Date.UTC(2024, 9, 27, 2, 30) / 1000;
  const earlier = localToUtc(local, table, 'earlier');
  const later = localToUtc(local, table, 'later');
  assert.equal(earlier.utc, civil - 7200); // 2024-10-27T00:30:00Z
  assert.equal(later.utc, civil - 3600); // 2024-10-27T01:30:00Z
  assert.equal(earlier.resolution, 'ambiguous-earlier');
  assert.equal(later.resolution, 'ambiguous-later');

  // Reproducible: repeated runs yield identical results.
  assert.deepEqual(localToUtc(local, table, 'earlier'), earlier);
  assert.deepEqual(localToUtc(local, table, 'later'), later);
});

test('nonexistent local time - strict/earlier/later policies', () => {
  const registry = new TzRegistry();
  const table = registry.load(gapTable());
  const local = '2024-03-31T02:30:00';
  const boundary = Date.UTC(2024, 2, 31, 1, 0, 0) / 1000;

  assert.throws(() => localToUtc(local, table, 'strict'), (err) => {
    assert.equal(err.code, CODES.AMBIG);
    assert.equal(err.details.kind, 'nonexistent');
    return true;
  });
  const earlier = localToUtc(local, table, 'earlier');
  const later = localToUtc(local, table, 'later');
  assert.equal(earlier.utc, boundary - 1); // last existing instant
  assert.equal(later.utc, boundary); // first existing instant after the gap
  assert.equal(earlier.resolution, 'nonexistent-earlier');
  assert.equal(later.resolution, 'nonexistent-later');
});

test('leap-style boundary resolves only via explicit per-version mapping', () => {
  const registry = loadExamples();
  const leap = '2024-06-30T23:59:60Z';
  const v1 = utcToLocal(leap, registry.get('v1'));
  const v2 = utcToLocal(leap, registry.get('v2'));
  assert.equal(v1.local, '2024-07-01T07:59:60+08:00');
  assert.equal(v2.local, '2024-07-01T06:59:60+07:00');
  assert.equal(v1.via, 'explicit');

  const bare = new TzRegistry();
  bare.load({ version: 'bare', segments: [{ utcStart: '2024-01-01T00:00:00Z', utcEnd: '2025-01-01T00:00:00Z', offsetSeconds: 0 }] });
  assert.throws(() => utcToLocal(leap, bare.get('bare')), (err) => err.code === CODES.TZVER);
});

test('E_TZVER: unknown version, uncovered instant, version immutability', () => {
  const registry = loadExamples();
  assert.throws(() => registry.get('v9'), (err) => err.code === CODES.TZVER);
  assert.throws(
    () => utcToLocal('2030-01-01T00:00:00Z', registry.get('v1')),
    (err) => err.code === CODES.TZVER
  );
  // Hot update with identical content is a no-op; different content under the
  // same version is rejected so history cannot be rewritten.
  registry.load(require('../examples/tz-v1.json'));
  assert.throws(
    () => registry.load({ ...require('../examples/tz-v1.json'), explicit: {} }),
    (err) => err.code === CODES.TZVER
  );
});

test('E_POLICY: unknown disambiguation policy', () => {
  const registry = new TzRegistry();
  const table = registry.load(foldTable());
  assert.throws(() => localToUtc('2024-10-27T02:30:00', table, 'whatever'), (err) => err.code === CODES.POLICY);
});

test('utcToLocal/localToUtc round trip on unambiguous instants', () => {
  const registry = new TzRegistry();
  const table = registry.load(gapTable());
  const utc = EPOCH_2024 + 40 * DAY + 3600;
  const { local } = utcToLocal(utc, table);
  const back = localToUtc(local.slice(0, 19), table, 'strict');
  assert.equal(back.utc, utc);
});
