'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { solveSchedule } = require('../src/scheduler');

// Independent brute-force enumerator: enumerates every ordered placement
// (target order x window choice) with earliest feasible start, no memo,
// no fairness -- pure max value over a single open timeline.
function enumBestValue(targets) {
  let best = 0;
  function rec(used, time, value) {
    if (value > best) best = value;
    for (let i = 0; i < targets.length; i++) {
      if (used & (1 << i)) continue;
      const t = targets[i];
      for (const [w0, w1] of t.windows) {
        const start = Math.max(w0, time + t.switch);
        const end = start + t.duration;
        if (end > w1) continue;
        rec(used | (1 << i), end, value + t.value);
      }
    }
  }
  rec(0, -Infinity, 0);
  return best;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test('acceptance 1: matches brute-force enumeration for n<=10', () => {
  for (let trial = 0; trial < 60; trial++) {
    const rand = rng(trial * 7919 + 13);
    const n = 2 + Math.floor(rand() * 9); // 2..10 targets
    const targets = [];
    for (let i = 0; i < n; i++) {
      const wcount = 1 + Math.floor(rand() * 2);
      const windows = [];
      for (let w = 0; w < wcount; w++) {
        const s = Math.floor(rand() * 40);
        windows.push([s, s + 5 + Math.floor(rand() * 30)]);
      }
      windows.sort((a, b) => a[0] - b[0]);
      targets.push({
        id: 'T' + i,
        pi: 'pi' + (i % 3),
        duration: 3 + Math.floor(rand() * 10),
        value: 1 + Math.floor(rand() * 20),
        switch: Math.floor(rand() * 4),
        windows,
      });
    }
    const expected = enumBestValue(targets);
    const got = solveSchedule(targets, [], {}).value;
    assert.equal(got, expected, `trial ${trial} targets=${JSON.stringify(targets)}`);
  }
});

test('acceptance 3: equal value and identical windows tie-break by target id', () => {
  const targets = [
    { id: 'T2', pi: 'a', duration: 10, value: 5, switch: 0, windows: [[0, 10]] },
    { id: 'T1', pi: 'a', duration: 10, value: 5, switch: 0, windows: [[0, 10]] },
  ];
  const r = solveSchedule(targets, [], {});
  assert.deepEqual(r.placements.map(p => p.target), ['T1']);
  // And when both fit, both are scheduled in time order.
  const r2 = solveSchedule(
    targets.map(t => ({ ...t, windows: [[0, 25]] })), [], {});
  assert.deepEqual(r2.placements.map(p => p.target), ['T1', 'T2']);
});

test('fairness: minimizes maximum PI quota deficit among equal-value schedules', () => {
  // {A1} gives deficits (alice 50, bob 0) -> max 50.
  // {Z1} gives deficits (alice 0, bob 40) -> max 40.
  // Fairness must pick Z1 even though A1 has the smaller target id.
  const targets = [
    { id: 'A1', pi: 'bob', duration: 40, value: 10, switch: 0, windows: [[0, 40]] },
    { id: 'Z1', pi: 'alice', duration: 50, value: 10, switch: 0, windows: [[0, 50]] },
  ];
  const r = solveSchedule(targets, [], { alice: 50, bob: 40 });
  assert.deepEqual(r.placements.map(p => p.target), ['Z1']);
});

test('switch cost is enforced between consecutive targets', () => {
  const targets = [
    { id: 'T1', pi: 'a', duration: 10, value: 5, switch: 0, windows: [[0, 10]] },
    { id: 'T2', pi: 'a', duration: 10, value: 5, switch: 7, windows: [[0, 30]] },
  ];
  const r = solveSchedule(targets, [], {});
  assert.deepEqual(
    r.placements.map(p => [p.target, p.start, p.end]),
    [['T1', 0, 10], ['T2', 17, 27]]);
});

test('schedules around fixed confirmed observations', () => {
  const targets = [
    { id: 'T1', pi: 'a', duration: 10, value: 5, switch: 2, windows: [[0, 100]] },
  ];
  const fixed = [{ id: 'o1', target: 'X', pi: 'a', start: 5, end: 40, value: 1 }];
  const r = solveSchedule(targets, fixed, {});
  // Before the fixed block only [0,5] is free (too small), so T1 goes after.
  assert.deepEqual(r.placements.map(p => [p.start, p.end]), [[42, 52]]);
});
