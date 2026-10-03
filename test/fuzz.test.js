'use strict';

// Acceptance 4: random small-sample cross-check of the optimized conversion
// (binary search + candidate arithmetic) against an independent reference
// that expands the timeline minute-by-minute.

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTable, offsetAt, utcToLocal, localToUtcCandidates } = require('../src/index');
const { refUtcToLocal, refLocalToUtcCandidates } = require('../src/reference');
const { MS_PER_MIN, MS_PER_DAY, civilToMs, msToCivil, formatLocal, parseUtcIso } = require('../src/time');

const ZONE = 'Merchant/Fuzz';

// deterministic PRNG (mulberry32)
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomTable(rand, transitionCount) {
  const anchor = parseUtcIso('2024-01-01T00:00:00Z', null);
  const transitions = [{ utc: '2024-01-01T00:00:00Z', offsetMinutes: Math.floor(rand() * 1561) - 720 }];
  let t = anchor;
  for (let i = 1; i < transitionCount; i++) {
    t += (1 + Math.floor(rand() * 72)) * 3600000; // 1..72h apart
    transitions.push({
      utc: new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      offsetMinutes: Math.floor(rand() * 1561) - 720, // -12h..+14h
    });
  }
  return normalizeTable({ version: 'fuzz', zones: { [ZONE]: { transitions } } });
}

test('utc->local matches minute-expansion reference on random samples', () => {
  const rand = rng(20241003);
  for (let trial = 0; trial < 10; trial++) {
    const table = randomTable(rand, 6);
    const anchor = parseUtcIso('2024-01-01T00:00:00Z', null);
    for (let s = 0; s < 40; s++) {
      const utcMs = anchor + Math.floor(rand() * 20 * MS_PER_DAY / MS_PER_MIN) * MS_PER_MIN;
      assert.equal(
        utcToLocal(table, ZONE, utcMs).localMs,
        refUtcToLocal(table, ZONE, utcMs),
        `utcToLocal mismatch at ${new Date(utcMs).toISOString()} trial ${trial}`,
      );
      assert.equal(offsetAt(table, ZONE, utcMs) * MS_PER_MIN + utcMs, refUtcToLocal(table, ZONE, utcMs));
    }
  }
});

test('local->utc candidate sets match minute-expansion reference on random samples', () => {
  const rand = rng(777);
  for (let trial = 0; trial < 10; trial++) {
    const table = randomTable(rand, 6);
    const anchorLocal = civilToMs({ y: 2024, mo: 1, d: 5, h: 0, mi: 0, s: 0, ms: 0 });
    for (let s = 0; s < 40; s++) {
      const localMs = anchorLocal + Math.floor(rand() * 20 * MS_PER_DAY / MS_PER_MIN) * MS_PER_MIN;
      const localIso = formatLocal(msToCivil(localMs));
      const fast = localToUtcCandidates(table, ZONE, localMs);
      const ref = refLocalToUtcCandidates(table, ZONE, localIso);
      assert.deepEqual(fast, ref, `candidate mismatch for ${localIso} trial ${trial}`);
    }
  }
});
