'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TzRegistry, utcToLocal, localCandidates } = require('../index');

// Seeded PRNG (mulberry32) so the sample is reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RAW_SEGMENTS = [
  { utcStart: '2024-01-01T00:00:00Z', utcEnd: '2024-01-02T16:00:00Z', offsetSeconds: 28800 },
  { utcStart: '2024-01-02T16:00:00Z', utcEnd: '2024-01-03T16:00:00Z', offsetSeconds: 32400 },
  { utcStart: '2024-01-03T16:00:00Z', utcEnd: '2024-01-05T00:00:00Z', offsetSeconds: 28800 },
];

// --- Independent reference: naive minute-by-minute expansion ---------------
// Deliberately shares no code with the library: linear scans, Date-only math.
const SEGS = RAW_SEGMENTS.map((s) => ({
  start: Date.parse(s.utcStart) / 1000,
  end: Date.parse(s.utcEnd) / 1000,
  off: s.offsetSeconds,
}));
const COVER_START = SEGS[0].start;
const COVER_END = SEGS[SEGS.length - 1].end;

function refCivilMinute(epochSeconds) {
  const seg = SEGS.find((s) => epochSeconds >= s.start && epochSeconds < s.end);
  if (!seg) return null;
  const d = new Date((epochSeconds + seg.off) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

const refByUtcMinute = new Map();
const refByLocalMinute = new Map();
for (let t = COVER_START; t < COVER_END; t += 60) {
  const civil = refCivilMinute(t);
  refByUtcMinute.set(t, civil);
  if (!refByLocalMinute.has(civil)) refByLocalMinute.set(civil, []);
  refByLocalMinute.get(civil).push(t);
}
// ---------------------------------------------------------------------------

const registry = new TzRegistry();
const table = registry.load({ version: 'fuzz', segments: RAW_SEGMENTS });

test('acceptance 4a: utcToLocal matches minute-expansion reference on random sample', () => {
  const rand = mulberry32(20241007);
  for (let i = 0; i < 500; i++) {
    const epoch = COVER_START + Math.floor(rand() * (COVER_END - COVER_START));
    const minute = Math.floor(epoch / 60) * 60;
    const expected = refByUtcMinute.get(minute);
    const actual = utcToLocal(epoch, table).local.slice(0, 16);
    assert.equal(actual, expected, `utcToLocal(${epoch})`);
  }
});

test('acceptance 4b: localCandidates matches brute-force inversion on random sample', () => {
  const rand = mulberry32(987654321);
  for (let i = 0; i < 500; i++) {
    const base = COVER_START + 28800 - 86400;
    const civilEpoch = base + Math.floor(rand() * (COVER_END - COVER_START + 2 * 86400));
    const d = new Date(Math.floor(civilEpoch / 60) * 60000);
    const p = (n) => String(n).padStart(2, '0');
    const civil = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
    const expected = refByLocalMinute.get(civil) || [];
    const actual = localCandidates(civil, table).map((u) => Math.floor(u / 60) * 60);
    assert.deepEqual(actual, expected, `localCandidates("${civil}")`);
  }
});

test('acceptance 4c: reference inversion of real instants round-trips through the library', () => {
  const rand = mulberry32(42);
  for (let i = 0; i < 300; i++) {
    const minute = COVER_START + Math.floor(rand() * ((COVER_END - COVER_START) / 60)) * 60;
    const civil = refByUtcMinute.get(minute);
    const candidates = localCandidates(civil, table);
    assert.ok(candidates.includes(minute), `minute ${minute} must be a candidate of its own local time ${civil}`);
    for (const c of candidates) {
      assert.equal(utcToLocal(c, table).local.slice(0, 16), civil);
    }
  }
});
