import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, referenceTimeline, mulberry32, TYPES } from '../src/index.js';

const DAY = 86_400_000;

function randEvents(rand, n) {
  const evs = [];
  for (let i = 0; i < n; i++) {
    const s = Math.floor(rand() * 80_000);
    const len = Math.floor(rand() * 20_000);
    evs.push({ id: `e${i}`, type: TYPES[Math.floor(rand() * TYPES.length)], start: s, end: s + len });
  }
  return evs;
}

// Acceptance 1: <=14 events, sweep pipeline matches reference enumeration of all legal intervals.
test('fuzz: sweep matches naive reference for <=14 events (300 seeds)', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rand = mulberry32(seed);
    const n = Math.floor(rand() * 15); // 0..14 events
    const events = randEvents(rand, n);
    const params = {
      maxSkewMs: Number.MAX_SAFE_INTEGER, // disable clock check; covered by clock tests
      minSegmentMs: [0, 500, 2000][Math.floor(rand() * 3)],
      changeoverPlannedBudgetMs: [5000, 10000, 30000][Math.floor(rand() * 3)],
    };
    const got = analyze({ events, params });
    assert.equal(got.ok, true, `seed ${seed}: ${JSON.stringify(got.error)}`);
    const want = referenceTimeline(events.filter((e) => e.end > e.start), params);
    assert.deepEqual(got.timeline, want, `seed ${seed}, n=${n}`);
  }
});

test('empty stream: ok, empty timeline, oee null', () => {
  const r = analyze({ events: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.timeline, []);
  assert.equal(r.oee, null);
});

test('all-day planned maintenance: fully planned, availability 1 by convention', () => {
  const r = analyze({ events: [{ id: 'm', type: 'maintenance', start: 0, end: DAY }] });
  assert.equal(r.ok, true);
  assert.equal(r.timeline.length, 1);
  assert.equal(r.timeline[0].state, 'maintenance');
  assert.equal(r.timeline[0].planned, true);
  assert.equal(r.oee.availability, 1);
  assert.equal(r.oee.unplannedDowntimeMs, 0);
  assert.equal(r.oee.oee, 1);
});

test('adjacent same-timestamp events produce clean half-open segments', () => {
  const r = analyze({
    events: [
      { id: 'a', type: 'run', start: 0, end: 100 },
      { id: 'b', type: 'fault', start: 100, end: 200 },
      { id: 'c', type: 'changeover', start: 200, end: 300 },
    ],
    params: { changeoverPlannedBudgetMs: 1000 },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.timeline.map((s) => [s.start, s.end, s.state, s.planned]),
    [[0, 100, 'run', true], [100, 200, 'fault', false], [200, 300, 'changeover', true]],
  );
});

test('zero-duration events carry no interval', () => {
  const r = analyze({
    events: [
      { id: 'z', type: 'fault', start: 50, end: 50 },
      { id: 'a', type: 'run', start: 0, end: 100 },
    ],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.timeline.map((s) => s.state), ['run']);
});

test('overlap: higher priority fault wins over run; uncovered gap is unplanned', () => {
  const r = analyze({
    events: [
      { id: 'r', type: 'run', start: 0, end: 1000 },
      { id: 'f', type: 'fault', start: 400, end: 600 },
    ],
  });
  assert.deepEqual(
    r.timeline.map((s) => [s.start, s.end, s.state]),
    [[0, 400, 'run'], [400, 600, 'fault'], [600, 1000, 'run']],
  );
  const g = analyze({ events: [{ id: 'r', type: 'run', start: 0, end: 100 }, { id: 'i', type: 'idle', start: 200, end: 300 }] });
  assert.deepEqual(g.timeline.map((s) => s.state), ['run', 'uncovered', 'idle']);
  assert.equal(g.timeline[1].planned, false);
});

test('threshold coupling: changeover budget decides planned/unplanned', () => {
  const mk = (dur) => analyze({ events: [{ id: 'c', type: 'changeover', start: 0, end: dur }] });
  assert.equal(mk(600_000).timeline[0].planned, true); // <= 30min budget
  assert.equal(mk(1_800_000).timeline[0].planned, true); // exactly at budget
  assert.equal(mk(1_800_001).timeline[0].planned, false); // over budget
  assert.match(mk(1_800_001).timeline[0].reason, /1800001ms > budget 1800000ms/);
});

test('threshold coupling: minSegmentMs absorbs short blips into the neighbor', () => {
  const r = analyze({
    events: [
      { id: 'r', type: 'run', start: 0, end: 10_000 },
      { id: 'f', type: 'fault', start: 5000, end: 5100 }, // 100ms blip
    ],
    params: { minSegmentMs: 1000 },
  });
  assert.equal(r.timeline.length, 1);
  assert.equal(r.timeline[0].state, 'run'); // 100ms fault blip is absorbed into the run neighbor
  assert.equal(r.timeline[0].end - r.timeline[0].start, 10_000);
  assert.deepEqual(r.timeline[0].sources.sort(), ['f', 'r']); // provenance kept
});

test('OEE attribution: unplanned downtime split by state, no double counting of overlaps', () => {
  const r = analyze({
    events: [
      { id: 'r', type: 'run', start: 0, end: 10_000 },
      { id: 'f1', type: 'fault', start: 2000, end: 5000 },
      { id: 'f2', type: 'fault', start: 4000, end: 6000 }, // overlaps f1
    ],
  });
  assert.equal(r.oee.unplannedDowntimeMs, 4000); // union [2000,6000), not 3000+2000
  assert.equal(r.oee.attribution.fault, 4000);
  assert.equal(r.oee.availability, 6000 / 10_000);
});
