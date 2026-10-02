import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRuns, periodWindows, segmentByPeriods, mergeDeviceEvents } from '../src/merge.js';
import { referenceIntervals, referenceWithPeriods } from '../testing/reference.js';

// Acceptance 3b: open interval (missing OFF) is produced up to the
// observation cutoff and flagged UNCLOSED, cross-checked per millisecond.
test('open interval: missing end event yields UNCLOSED interval to cutoff', () => {
  const events = [
    { id: 'e1', utcMs: 1000, state: 'ON', version: 1 },
    { id: 'e2', utcMs: 2000, state: 'OFF', version: 2 },
    { id: 'e3', utcMs: 3000, state: 'ON', version: 3 }, // never closed
  ];
  const from = 0, to = 5000;
  const runs = buildRuns(events, from, to);
  assert.deepEqual(
    runs.map(r => [r.state, r.start, r.end, r.unclosed]),
    [['ON', 1000, 2000, false], ['OFF', 2000, 3000, false], ['ON', 3000, 5000, true]],
  );
  const ref = referenceIntervals(events, from, to);
  assert.deepEqual(
    runs.map(r => ({ state: r.state, start: r.start, end: r.end })),
    ref,
    'library output matches per-millisecond reference enumeration',
  );
});

test('randomized cross-check against per-millisecond reference', () => {
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let trial = 0; trial < 30; trial++) {
    const from = 0, to = 2000;
    const n = 1 + Math.floor(rand() * 12);
    const events = [];
    for (let i = 0; i < n; i++) {
      events.push({
        id: `r${trial}e${i}`,
        utcMs: Math.floor(rand() * 2200) - 100, // some outside the window
        state: rand() < 0.5 ? 'ON' : 'OFF',
        version: i,
      });
    }
    const runs = buildRuns(events, from, to);
    const ref = referenceIntervals(events, from, to);
    assert.deepEqual(
      runs.map(r => ({ state: r.state, start: r.start, end: r.end })),
      ref,
      `trial ${trial} mismatch`,
    );
    // UNCLOSED iff the last reference segment reaches the cutoff.
    const last = runs[runs.length - 1];
    if (last) assert.equal(last.unclosed, ref[ref.length - 1].end === to && true);
  }
});

test('millisecond merge: duplicate events at the same ms keep all original ids', () => {
  const events = [
    { id: 'a', utcMs: 500, state: 'ON', version: 1 },
    { id: 'b', utcMs: 500, state: 'ON', version: 2 }, // exact duplicate ms
    { id: 'c', utcMs: 700, state: 'ON', version: 3 }, // repeated state
    { id: 'd', utcMs: 900, state: 'OFF', version: 4 },
  ];
  const runs = buildRuns(events, 0, 1000);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0].ids, ['a', 'b', 'c']);
  assert.deepEqual(runs[1].ids, ['d']);
});

// Acceptance 3a: period inversion is an error.
test('period inversion is rejected', () => {
  assert.throws(() => periodWindows({ start: 0, durationMs: 0, end: 100 }), /PERIOD_INVERSION/);
  assert.throws(() => periodWindows({ start: 0, durationMs: -5, end: 100 }), /PERIOD_INVERSION/);
  assert.throws(() => periodWindows({ start: 100, durationMs: 10, end: 100 }), /PERIOD_INVERSION/);
  assert.throws(() => periodWindows({ start: 200, durationMs: 10, end: 100 }), /PERIOD_INVERSION/);
});

test('period windows from start/duration/end', () => {
  assert.deepEqual(periodWindows({ start: 0, durationMs: 1000, end: 3000 }),
    [{ start: 0, end: 1000 }, { start: 1000, end: 2000 }, { start: 2000, end: 3000 }]);
  assert.deepEqual(periodWindows({ start: 0, durationMs: 1000, end: 2500 }),
    [{ start: 0, end: 1000 }, { start: 1000, end: 2000 }, { start: 2000, end: 2500 }]);
});

test('silence window merges adjacent same-state periods; without silence they stay split', () => {
  const events = [{ id: 'e1', utcMs: 100, state: 'ON', version: 1 }];
  const period = { start: 0, durationMs: 1000, end: 3000 };
  const windows = periodWindows(period);

  const split = mergeDeviceEvents(events, { from: 0, to: 3000, period, silence: [] });
  assert.equal(split.intervals.length, 3, 'one segment per period without silence');

  const merged = mergeDeviceEvents(events, { from: 0, to: 3000, period, silence: [{ start: 0, end: 3000 }] });
  assert.equal(merged.intervals.length, 1, 'all three periods merge inside one silence window');
  assert.deepEqual([merged.intervals[0].start, merged.intervals[0].end], [100, 3000]);
  assert.equal(merged.intervals[0].unclosed, true);

  // Cross-check with the per-millisecond reference.
  const ref = referenceWithPeriods(events, 0, 3000, windows, [{ start: 0, end: 3000 }]);
  assert.deepEqual(
    merged.intervals.map(i => ({ state: i.state, start: i.start, end: i.end })),
    ref,
  );
});

test('silence does not merge across different states or outside the silence window', () => {
  const events = [
    { id: 'e1', utcMs: 100, state: 'ON', version: 1 },
    { id: 'e2', utcMs: 1500, state: 'OFF', version: 2 },
  ];
  const period = { start: 0, durationMs: 1000, end: 3000 };
  const out = mergeDeviceEvents(events, { from: 0, to: 3000, period, silence: [{ start: 0, end: 3000 }] });
  // ON spans periods 0-1 (merged), OFF spans periods 1-2 (merged): 2 intervals.
  assert.deepEqual(out.intervals.map(i => [i.state, i.start, i.end]),
    [['ON', 100, 1500], ['OFF', 1500, 3000]]);

  // Silence only covers period 0: no merging of the ON part beyond period 0->1? 
  const out2 = mergeDeviceEvents(events, { from: 0, to: 3000, period, silence: [{ start: 0, end: 1000 }] });
  assert.deepEqual(out2.intervals.map(i => [i.state, i.start, i.end]),
    [['ON', 100, 1000], ['ON', 1000, 1500], ['OFF', 1500, 2000], ['OFF', 2000, 3000]]);
});
