import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  analyzeDevice,
  analyzeEvents,
  buildPredecessors,
  enumerateTopoOrders,
  rawIntervals,
  totalDuration,
  unionIntervals,
} from '../src/analyze.js';
import { compareClocks } from '../src/clock.js';

const ev = (id, device, ts, state, node, clock) => ({ id, device, ts, state, node, clock });

describe('vector clocks', () => {
  it('orders causally related and concurrent clocks', () => {
    assert.equal(compareClocks({ a: 1 }, { a: 2 }), -1);
    assert.equal(compareClocks({ a: 2 }, { a: 1 }), 1);
    assert.equal(compareClocks({ a: 1, b: 2 }, { a: 1, b: 2 }), 0);
    assert.equal(compareClocks({ a: 1 }, { b: 1 }), null);
    assert.equal(compareClocks({ a: 2, b: 1 }, { a: 1, b: 2 }), null);
  });
});

describe('scenario 1: causally reordered events give a determined result', () => {
  const causal = [
    ev('e1', 'A', 10, 'down', 'n1', { n1: 1 }),
    ev('e2', 'A', 20, 'up', 'n2', { n1: 1, n2: 1 }),
    ev('e3', 'A', 30, 'down', 'n1', { n1: 2, n2: 1 }),
    ev('e4', 'A', 40, 'up', 'n2', { n1: 2, n2: 2 }),
  ];
  const shuffled = [causal[2], causal[0], causal[3], causal[1]];

  it('arrival order does not change the analysis', () => {
    const expected = analyzeDevice(causal, { watermark: 50 });
    const actual = analyzeDevice(shuffled, { watermark: 50 });
    assert.deepEqual(actual, expected);
    assert.equal(actual.status, 'ok');
    assert.equal(actual.downtime, 20);
    assert.deepEqual(actual.intervals, [
      { start: 10, end: 20 },
      { start: 30, end: 40 },
    ]);
    assert.equal(actual.availability, 0.5);
  });
});

describe('scenario 2: concurrent toggles on one device are ambiguous', () => {
  const events = [
    ev('a', 'B', 10, 'down', 'n1', { n1: 1 }),
    ev('b', 'B', 12, 'up', 'n2', { n2: 1 }),
  ];

  it('reports ambiguous with min/max downtime, not an error', () => {
    const result = analyzeDevice(events, { watermark: 20 });
    assert.equal(result.status, 'ambiguous');
    assert.equal(result.downtime, null);
    assert.equal(result.minDowntime, 2);
    assert.equal(result.maxDowntime, 10);
    assert.equal(result.linearizations, 2);
    assert.equal(result.nullDowntimePossible, false);
  });

  it('open-ended concurrent linearization yields null downtime possibility', () => {
    const result = analyzeDevice(events);
    assert.equal(result.status, 'ambiguous');
    assert.equal(result.minDowntime, 2);
    assert.equal(result.maxDowntime, 2);
    assert.equal(result.nullDowntimePossible, true);
  });
});

describe('scenario 3: missing end before the watermark gives null durations', () => {
  const events = [ev('c', 'C', 5, 'down', 'n1', { n1: 1 })];

  it('no watermark: end and downtime are null', () => {
    const result = analyzeDevice(events);
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.intervals, [{ start: 5, end: null }]);
    assert.equal(result.downtime, null);
    assert.equal(result.availability, null);
  });

  it('watermark not reached: end stays null', () => {
    const result = analyzeDevice(events, { watermark: 3 });
    assert.deepEqual(result.intervals, [{ start: 5, end: null }]);
    assert.equal(result.downtime, null);
  });

  it('watermark reached: interval closes at the watermark', () => {
    const result = analyzeDevice(events, { watermark: 15 });
    assert.deepEqual(result.intervals, [{ start: 5, end: 15 }]);
    assert.equal(result.downtime, 10);
    assert.equal(result.availability, 0);
  });
});

describe('interval union', () => {
  it('merges overlapping and adjacent intervals', () => {
    const merged = unionIntervals([
      { start: 10, end: 20 },
      { start: 15, end: 25 },
      { start: 40, end: 50 },
      { start: 25, end: 30 },
    ]);
    assert.deepEqual(merged, [
      { start: 10, end: 30 },
      { start: 40, end: 50 },
    ]);
    assert.equal(totalDuration(merged), 30);
  });

  it('an open interval swallows later ones and makes the total null', () => {
    const merged = unionIntervals([
      { start: 10, end: null },
      { start: 20, end: 30 },
    ]);
    assert.deepEqual(merged, [{ start: 10, end: null }]);
    assert.equal(totalDuration(merged), null);
  });
});

// Independent cross-check: brute-force every permutation of <= 8 events,
// keep those respecting the causal poset, and compare the resulting downtime
// multiset with the library's own topological enumeration.
function bruteForceDowntimes(events, watermark) {
  const predecessors = buildPredecessors(events);
  const downtimes = [];
  const indices = events.map((_, i) => i);

  function respectsOrder(perm) {
    const position = new Map(perm.map((eventIdx, pos) => [eventIdx, pos]));
    for (let j = 0; j < events.length; j += 1) {
      for (const i of predecessors[j]) {
        if (position.get(i) >= position.get(j)) return false;
      }
    }
    return true;
  }

  function permute(prefix, rest) {
    if (rest.length === 0) {
      if (respectsOrder(prefix)) {
        const ordered = prefix.map((i) => events[i]);
        downtimes.push(totalDuration(unionIntervals(rawIntervals(ordered, watermark))));
      }
      return;
    }
    for (let k = 0; k < rest.length; k += 1) {
      permute([...prefix, rest[k]], [...rest.slice(0, k), ...rest.slice(k + 1)]);
    }
  }

  permute([], indices);
  return downtimes;
}

function libraryDowntimes(events, watermark) {
  const { orders } = enumerateTopoOrders(events);
  return orders.map((ordered) =>
    totalDuration(unionIntervals(rawIntervals(ordered, watermark))),
  );
}

const sortMultiset = (values) =>
  values.map((v) => String(v)).sort();

describe('cross-check: library enumeration matches brute-force permutations (<= 8 events)', () => {
  const devices = {
    // 6 events, mixed causal chains and concurrency across three nodes.
    D1: [
      ev('p1', 'D1', 10, 'down', 'n1', { n1: 1 }),
      ev('p2', 'D1', 20, 'up', 'n1', { n1: 2 }),
      ev('p3', 'D1', 15, 'down', 'n2', { n2: 1 }),
      ev('p4', 'D1', 25, 'up', 'n2', { n2: 2 }),
      ev('p5', 'D1', 30, 'down', 'n3', { n1: 2, n2: 2, n3: 1 }),
      ev('p6', 'D1', 35, 'up', 'n3', { n1: 2, n2: 2, n3: 2 }),
    ],
    // 8 events: two fully concurrent chains of four toggles each.
    D2: [
      ev('q1', 'D2', 10, 'down', 'n1', { n1: 1 }),
      ev('q2', 'D2', 20, 'up', 'n1', { n1: 2 }),
      ev('q3', 'D2', 30, 'down', 'n1', { n1: 3 }),
      ev('q4', 'D2', 40, 'up', 'n1', { n1: 4 }),
      ev('q5', 'D2', 12, 'down', 'n2', { n2: 1 }),
      ev('q6', 'D2', 22, 'up', 'n2', { n2: 2 }),
      ev('q7', 'D2', 32, 'down', 'n2', { n2: 3 }),
      ev('q8', 'D2', 42, 'up', 'n2', { n2: 4 }),
    ],
  };

  for (const [device, events] of Object.entries(devices)) {
    for (const watermark of [null, 45]) {
      it(`${device} (${events.length} events, watermark=${watermark})`, () => {
        assert.ok(events.length <= 8);
        const expected = sortMultiset(bruteForceDowntimes(events, watermark));
        const actual = sortMultiset(libraryDowntimes(events, watermark));
        assert.deepEqual(actual, expected);
        assert.ok(actual.length > 0);
      });
    }
  }

  it('analyzeEvents groups by device', () => {
    const report = analyzeEvents(
      [
        ev('r1', 'X', 1, 'down', 'n1', { n1: 1 }),
        ev('r2', 'Y', 2, 'down', 'n1', { n1: 2 }),
        ev('r3', 'X', 3, 'up', 'n1', { n1: 3 }),
      ],
      { watermark: 10 },
    );
    assert.deepEqual(Object.keys(report.devices), ['X', 'Y']);
    assert.equal(report.devices.X.status, 'ok');
    assert.equal(report.devices.X.downtime, 2);
    assert.equal(report.devices.Y.downtime, 8);
  });
});
