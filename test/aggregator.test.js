'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Aggregator, computeWindow, WINDOW_SECONDS } = require('../src/aggregator');
const { referenceWindows } = require('../src/reference');

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test('incremental aggregator matches second-by-second reference on random data', () => {
  for (let trial = 0; trial < 30; trial += 1) {
    const rng = makeRng(trial + 1);
    const events = [];
    const n = 1 + Math.floor(rng() * 12);
    for (let i = 0; i < n; i += 1) {
      events.push({
        id: `e${trial}-${i}`,
        device: rng() < 0.5 ? 'A' : 'B',
        ts: Math.floor(rng() * 4000),
        state: rng() < 0.5 ? 'up' : 'down',
      });
    }
    for (const device of ['A', 'B']) {
      const agg = new Aggregator();
      for (const ev of events) agg.addEvent(ev);
      const expected = referenceWindows(events, device, 0, 5400);
      for (const row of expected) {
        const got = computeWindow(agg.sortedEvents(device), row.window);
        assert.deepEqual(
          got,
          { uptime: row.uptime, downtime: row.downtime, unknown: row.unknown },
          `trial=${trial} device=${device} window=${row.window}`,
        );
        assert.equal(got.uptime === null ? WINDOW_SECONDS : got.uptime + got.downtime + got.unknown, WINDOW_SECONDS);
      }
    }
  }
});

test('event exactly on window boundary affects only the later window', () => {
  const events = [{ id: 'e1', device: 'A', ts: 900, state: 'up' }];
  const rows = referenceWindows(events, 'A', 0, 1800);
  assert.deepEqual(rows[0], { device: 'A', window: 0, uptime: null, downtime: null, unknown: 900 });
  assert.deepEqual(rows[1], { device: 'A', window: 900, uptime: 900, downtime: 0, unknown: 0 });
});

test('duplicate event ids are applied once', () => {
  const agg = new Aggregator();
  const ev = { id: 'e1', device: 'A', ts: 10, state: 'up' };
  assert.equal(agg.addEvent(ev).duplicate, false);
  assert.equal(agg.addEvent({ ...ev }).duplicate, true);
  assert.equal(agg.sortedEvents('A').length, 1);
});

test('same-timestamp events resolve deterministically by id', () => {
  const agg = new Aggregator();
  agg.addEvent({ id: 'b', device: 'A', ts: 100, state: 'down' });
  agg.addEvent({ id: 'a', device: 'A', ts: 100, state: 'up' });
  const got = computeWindow(agg.sortedEvents('A'), 0);
  // later key in sort order (id 'b', down) wins from ts=100 onward
  assert.deepEqual(got, { uptime: 0, downtime: 800, unknown: 100 });
});
