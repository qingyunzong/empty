import test from 'node:test';
import assert from 'node:assert/strict';
import { IntervalSet, referenceOverlaps } from '../src/intervals.js';
import { makeStore, weekdayWindowConfig } from '../test-utils/helpers.js';

// Acceptance 3: zero-length defects touching a boundary never block, and the
// optimized interval set agrees with a reference algorithm that enumerates
// every candidate batch and every defect interval.
test('zero-length and boundary-touching defects do not block a batch', () => {
  const span = ['2026-01-10T00:00:00Z', '2026-01-20T00:00:00Z'];
  const store = makeStore(weekdayWindowConfig({
    defects: [
      ['2026-01-20T00:00:00Z', '2026-01-20T00:00:00Z'], // zero-length at right boundary
      ['2026-01-10T00:00:00Z', '2026-01-10T00:00:00Z'], // zero-length at left boundary
      ['2026-01-05T00:00:00Z', '2026-01-10T00:00:00Z'], // touches left boundary
      ['2026-01-20T00:00:00Z', '2026-01-25T00:00:00Z'], // touches right boundary
    ],
  }));
  store.apply({ cmd: 'receive', batch: 'B1', qty: 10, expiry: '2026-07-01T00:00:00Z', span });
  store.apply({ cmd: 'available', batch: 'B1' });
  store.apply({ cmd: 'inspect', batch: 'B1', inspectedAt: '2026-06-01T10:00:00Z', passed: true });
  const issuable = store.apply({ cmd: 'issuable', at: '2026-06-02T10:00:00Z' });
  assert.deepEqual(issuable.batches.map((b) => b.batch), ['B1']);

  // A defect strictly inside the span does block.
  store.apply({ cmd: 'defects', add: [['2026-01-15T00:00:00Z', '2026-01-16T00:00:00Z']] });
  const blocked = store.apply({ cmd: 'issuable', at: '2026-06-02T10:00:00Z' });
  assert.deepEqual(blocked.batches, []);
});

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('interval set matches reference enumeration over randomized cases', () => {
  const rand = mulberry32(42);
  for (let trial = 0; trial < 300; trial++) {
    const raw = [];
    const set = new IntervalSet();
    const defectCount = Math.floor(rand() * 12);
    for (let i = 0; i < defectCount; i++) {
      const s = Math.floor(rand() * 100);
      // Bias towards zero-length and boundary-touching intervals.
      const e = rand() < 0.3 ? s : s + Math.floor(rand() * 20);
      raw.push([s, e]);
      set.add(s, e);
    }
    // Enumerate every candidate batch span and compare both algorithms.
    for (let candidate = 0; candidate < 40; candidate++) {
      const s = Math.floor(rand() * 100);
      const e = rand() < 0.2 ? s : s + Math.floor(rand() * 30);
      assert.equal(
        set.overlaps(s, e),
        referenceOverlaps(raw, s, e),
        `trial ${trial} candidate [${s}, ${e}) defects ${JSON.stringify(raw)}`,
      );
    }
  }
});

test('store-level issuability matches per-batch reference enumeration', () => {
  const rand = mulberry32(7);
  const defects = [];
  for (let i = 0; i < 8; i++) {
    const s = Math.floor(rand() * 50);
    defects.push([s, rand() < 0.3 ? s : s + Math.floor(rand() * 10)]);
  }
  const store = makeStore(weekdayWindowConfig({
    defects: defects.map(([s, e]) => [s * 60000, e * 60000]),
  }));
  const expected = [];
  for (let i = 0; i < 25; i++) {
    const s = Math.floor(rand() * 60);
    const e = rand() < 0.2 ? s : s + Math.floor(rand() * 15);
    const id = `C${i}`;
    store.apply({ cmd: 'receive', batch: id, qty: 5, expiry: '2026-07-01T00:00:00Z', span: [s * 60000, e * 60000] });
    store.apply({ cmd: 'available', batch: id });
    store.apply({ cmd: 'inspect', batch: id, inspectedAt: '2026-06-01T10:00:00Z', passed: true });
    if (!referenceOverlaps(defects, s, e)) expected.push(id);
  }
  const issuable = store.apply({ cmd: 'issuable', at: '2026-06-02T10:00:00Z' });
  assert.deepEqual(issuable.batches.map((b) => b.batch).sort(), expected.sort());
});
