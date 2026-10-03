import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareClocks } from '../src/vectorClock.js';
import { summarizeDevice, summarizeAll } from '../src/engine.js';
import {
  loadStore,
  saveStore,
  ingestEvents,
  queryStore,
  diffStore,
} from '../src/store.js';

// ---------- Acceptance scenario 1: causal out-of-order ----------

const causalEvents = [
  { id: 'e1', device: 'pump-1', ts: 1000, state: 'down', node: 'A', clock: { A: 1 } },
  { id: 'e2', device: 'pump-1', ts: 1600, state: 'up', node: 'B', clock: { A: 1, B: 1 } },
  { id: 'e3', device: 'pump-1', ts: 2000, state: 'down', node: 'C', clock: { A: 1, B: 1, C: 1 } },
  { id: 'e4', device: 'pump-1', ts: 2400, state: 'up', node: 'A', clock: { A: 2, B: 1, C: 1 } },
];

test('scenario 1: causally shuffled ingestion yields the same determined result', () => {
  const shuffled = [causalEvents[1], causalEvents[3], causalEvents[0], causalEvents[2]];
  const fromSorted = summarizeAll(causalEvents);
  const fromShuffled = summarizeAll(shuffled);
  assert.deepEqual(fromShuffled, fromSorted);
  const device = fromShuffled['pump-1'];
  assert.equal(device.status, 'determined');
  assert.equal(device.downtimeMs, 1000);
  assert.deepEqual(
    device.intervals.map(({ start, end }) => [start, end]),
    [[1000, 1600], [2000, 2400]],
  );
  assert.ok(Math.abs(device.availability - (1 - 1000 / 1400)) < 1e-6);
});

// ---------- Acceptance scenario 2: concurrent toggles are ambiguous ----------

const concurrentEvents = [
  { id: 'c1', device: 'valve-7', ts: 10, state: 'down', node: 'A', clock: { A: 1 } },
  { id: 'c2', device: 'valve-7', ts: 20, state: 'up', node: 'B', clock: { B: 1 } },
  { id: 'c3', device: 'valve-7', ts: 50, state: 'up', node: 'A', clock: { A: 2, B: 1 } },
];

test('scenario 2: concurrent toggles produce ambiguous status with min/max downtime', () => {
  const result = summarizeDevice('valve-7', concurrentEvents);
  assert.equal(result.status, 'ambiguous');
  // Linearization c1,c2,c3 -> downtime [10,20] = 10
  // Linearization c2,c1,c3 -> downtime [10,50] = 40
  assert.equal(result.minDowntimeMs, 10);
  assert.equal(result.maxDowntimeMs, 40);
  assert.equal(result.linearizations, 2);
  // Ambiguity is a first-class result, not an error.
  assert.ok(Array.isArray(result.intervals));
});

test('concurrent events with identical outcomes stay determined', () => {
  // k3 is concurrent with the causal chain k1 -> k2, but it is a redundant
  // "up" in every linearization, so all orders agree on [10, 30].
  const events = [
    { id: 'k1', device: 'd', ts: 10, state: 'down', node: 'A', clock: { A: 1 } },
    { id: 'k2', device: 'd', ts: 30, state: 'up', node: 'A', clock: { A: 2 } },
    { id: 'k3', device: 'd', ts: 15, state: 'up', node: 'B', clock: { B: 1 } },
  ];
  const result = summarizeDevice('d', events);
  assert.equal(result.linearizations, 3);
  assert.equal(result.status, 'determined');
  assert.equal(result.downtimeMs, 20);
});

// ---------- Acceptance scenario 3: open interval before watermark ----------

test('scenario 3: missing end and unreached watermark yield null durations', () => {
  const events = [
    { id: 's1', device: 'sensor-3', ts: 500, state: 'down', node: 'N1', clock: { N1: 1 } },
  ];
  const before = summarizeDevice('sensor-3', events);
  assert.equal(before.status, 'determined');
  assert.equal(before.downtimeMs, null);
  assert.equal(before.availability, null);
  assert.deepEqual(before.intervals, [{ start: 500, end: null, open: true }]);

  const after = summarizeDevice('sensor-3', events, { watermark: 800 });
  assert.equal(after.downtimeMs, 300);
  assert.deepEqual(after.intervals, [{ start: 500, end: 800, open: true }]);
  assert.equal(after.availability, 0);
});

test('explicit end on a down event closes the interval immediately', () => {
  const events = [
    { id: 'w1', device: 'd', ts: 100, state: 'down', end: 250, node: 'A', clock: { A: 1 } },
  ];
  const result = summarizeDevice('d', events);
  assert.equal(result.downtimeMs, 150);
  assert.equal(result.status, 'determined');
});

// ---------- Idempotency and versioned corrections ----------

function withTempStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'downtime-test-'));
  const path = join(dir, 'state.json');
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('duplicate event ids are idempotent and do not bump the version', () => {
  withTempStore((path) => {
    let store = loadStore(path);
    const first = ingestEvents(store, causalEvents);
    saveStore(store, path);
    assert.equal(first.version, 1);
    assert.equal(first.added.length, 4);

    store = loadStore(path);
    const second = ingestEvents(store, [causalEvents[0], causalEvents[2]]);
    assert.equal(second.version, 1);
    assert.equal(second.added.length, 0);
    assert.deepEqual(second.duplicates.sort(), ['e1', 'e3']);
    assert.equal(Object.keys(store.events).length, 4);
  });
});

test('late events produce versioned incremental corrections visible via diff', () => {
  withTempStore((path) => {
    let store = loadStore(path);
    ingestEvents(store, causalEvents);
    saveStore(store, path);

    const lateBatch = [
      { id: 'e5', device: 'pump-1', ts: 3000, state: 'down', node: 'A', clock: { A: 3, B: 1, C: 1 } },
      { id: 'e6', device: 'pump-1', ts: 3400, state: 'up', node: 'A', clock: { A: 4, B: 1, C: 1 } },
    ];
    store = loadStore(path);
    const ingested = ingestEvents(store, lateBatch);
    saveStore(store, path);
    assert.equal(ingested.version, 2);

    store = loadStore(path);
    const diff = diffStore(store, { from: 1, to: 2 });
    assert.equal(diff.corrections.length, 1);
    assert.equal(diff.corrections[0].version, 2);
    assert.deepEqual(diff.corrections[0].added, ['e5', 'e6']);
    assert.deepEqual(diff.changes['pump-1'].downtimeMs, { from: 1000, to: 1400 });

    const v1Events = Object.values(store.events).filter((e) => e.ingestedAt <= 1);
    assert.equal(summarizeAll(v1Events)['pump-1'].downtimeMs, 1000);
    const v2 = queryStore(store);
    assert.equal(v2.devices['pump-1'].downtimeMs, 1400);
  });
});

test('late flag marks events arriving below the device high-water mark', () => {
  withTempStore((path) => {
    const store = loadStore(path);
    ingestEvents(store, [
      { id: 'a1', device: 'd', ts: 100, state: 'down', node: 'A', clock: { A: 1 } },
      { id: 'a2', device: 'd', ts: 900, state: 'up', node: 'A', clock: { A: 2 } },
    ]);
    const late = ingestEvents(store, [
      { id: 'a3', device: 'd', ts: 50, state: 'up', node: 'B', clock: { B: 1 } },
    ]);
    assert.deepEqual(late.late, ['a3']);
    saveStore(store, path);
  });
});

// ---------- Reference check: independent brute-force enumeration ----------

function* permutations(items) {
  if (items.length <= 1) {
    yield [...items];
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const perm of permutations(rest)) yield [items[i], ...perm];
  }
}

// Independent happens-before written separately from src/vectorClock.js.
function refHappensBefore(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let strictlyLess = false;
  for (const key of keys) {
    if ((a[key] ?? 0) > (b[key] ?? 0)) return false;
    if ((a[key] ?? 0) < (b[key] ?? 0)) strictlyLess = true;
  }
  return strictlyLess;
}

function refConstraintPairs(events) {
  const pairs = [];
  for (const a of events) {
    for (const b of events) {
      if (a.id !== b.id && refHappensBefore(a.clock, b.clock)) pairs.push([a.id, b.id]);
    }
  }
  return pairs;
}

function refIsLinearization(positions, pairs) {
  for (const [before, after] of pairs) {
    if (positions.get(before) >= positions.get(after)) return false;
  }
  return true;
}

// Independent interval/downtime computation for the reference oracle.
// Returns the same {merged, unresolved} shape the engine uses as its
// distinct-result key, including the `open` provenance flag.
function refIntervals(ordered, watermark) {
  const raw = [];
  let down = null;
  for (const event of ordered) {
    if (event.state === 'down') {
      if (down !== null) continue;
      if (event.end !== undefined && event.end !== null) {
        raw.push({ start: event.ts, end: event.end, open: false });
      } else {
        down = event.ts;
      }
    } else if (down !== null) {
      raw.push({ start: down, end: event.ts, open: false });
      down = null;
    }
  }
  if (down !== null) {
    if (watermark !== null && watermark > down) raw.push({ start: down, end: watermark, open: true });
    else raw.push({ start: down, end: null, open: true });
  }
  const closed = raw
    .filter((i) => i.end !== null)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const interval of closed) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
      last.open = last.open || interval.open;
    } else {
      merged.push({ ...interval });
    }
  }
  const unresolved = raw.filter((i) => i.end === null);
  return { merged, unresolved };
}

function refSummary(events, watermark) {
  const pairs = refConstraintPairs(events);
  let min = null;
  let max = null;
  let count = 0;
  const distinct = new Set();
  for (const perm of permutations(events)) {
    const positions = new Map(perm.map((event, index) => [event.id, index]));
    if (!refIsLinearization(positions, pairs)) continue;
    count += 1;
    const { merged, unresolved } = refIntervals(perm, watermark);
    distinct.add(JSON.stringify({ merged, unresolved }));
    if (unresolved.length > 0) continue;
    const total = merged.reduce((sum, i) => sum + (i.end - i.start), 0);
    min = min === null ? total : Math.min(min, total);
    max = max === null ? total : Math.max(max, total);
  }
  return { min, max, count, distinctCount: distinct.size };
}

// Seeded PRNG for reproducible fuzzing.
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomEvents(rand, count) {
  const nodes = ['A', 'B', 'C'];
  const clocks = new Map(nodes.map((n) => [n, {}]));
  const events = [];
  for (let i = 0; i < count; i++) {
    const node = nodes[Math.floor(rand() * nodes.length)];
    const clock = { ...clocks.get(node) };
    if (rand() < 0.6) {
      const other = nodes[Math.floor(rand() * nodes.length)];
      for (const [key, value] of Object.entries(clocks.get(other))) {
        clock[key] = Math.max(clock[key] ?? 0, value);
      }
    }
    clock[node] = (clock[node] ?? 0) + 1;
    clocks.set(node, clock);
    const event = {
      id: `r${i}`,
      device: 'dev',
      ts: Math.floor(rand() * 1000),
      state: rand() < 0.5 ? 'up' : 'down',
      node,
      clock,
    };
    if (rand() < 0.2) event.end = event.ts + Math.floor(rand() * 100);
    events.push(event);
  }
  return events;
}

test('fuzz (<=8 events): engine matches independent brute-force enumeration', () => {
  const rand = mulberry32(20261003);
  for (let trial = 0; trial < 25; trial++) {
    const count = 2 + Math.floor(rand() * 7); // 2..8 events
    const events = randomEvents(rand, count);
    const watermark = rand() < 0.5 ? null : Math.floor(rand() * 1200);
    const expected = refSummary(events, watermark);
    const actual = summarizeDevice('dev', events, { watermark });
    assert.equal(
      actual.linearizations,
      expected.count,
      `trial ${trial}: linearization count mismatch`,
    );
    const expectAmbiguous = expected.distinctCount > 1;
    assert.equal(
      actual.status,
      expectAmbiguous ? 'ambiguous' : 'determined',
      `trial ${trial}: status mismatch`,
    );
    if (expectAmbiguous) {
      assert.equal(actual.minDowntimeMs, expected.min, `trial ${trial}: min mismatch`);
      assert.equal(actual.maxDowntimeMs, expected.max, `trial ${trial}: max mismatch`);
    } else {
      assert.equal(actual.downtimeMs, expected.min, `trial ${trial}: downtime mismatch`);
    }
  }
});

// ---------- Vector clock basics ----------

test('vector clock comparison', () => {
  assert.equal(compareClocks({ A: 1 }, { A: 2 }), -1);
  assert.equal(compareClocks({ A: 2 }, { A: 1 }), 1);
  assert.equal(compareClocks({ A: 1, B: 1 }, { A: 1, B: 1 }), 0);
  assert.equal(compareClocks({ A: 1 }, { B: 1 }), null);
  assert.equal(compareClocks({ A: 1, B: 2 }, { A: 1, B: 3 }), -1);
});

test('overlapping downtime intervals merge into a union', () => {
  const events = [
    { id: 'm1', device: 'd', ts: 0, state: 'down', end: 200, node: 'A', clock: { A: 1 } },
    { id: 'm2', device: 'd', ts: 100, state: 'down', end: 300, node: 'B', clock: { B: 1 } },
  ];
  const result = summarizeDevice('d', events);
  // raw intervals [0,200] and [100,300] union to [0,300]
  assert.equal(result.status, 'determined');
  assert.equal(result.downtimeMs, 300);
  assert.deepEqual(
    result.intervals.map(({ start, end }) => [start, end]),
    [[0, 300]],
  );
});
