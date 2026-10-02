import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, dispute } from '../src/index.js';

test('acceptance 4: disputed segment returns minimal event subset reproducing the verdict', () => {
  const events = [
    { id: 'r', type: 'run', start: 0, end: 10_000 },
    { id: 'f', type: 'fault', start: 0, end: 5000 }, // extends beyond the disputed interval
    { id: 'i', type: 'idle', start: 5000, end: 6000 },
  ];
  const d = dispute({ events, interval: { start: 1000, end: 3000 } });
  assert.equal(d.ok, true);
  assert.equal(d.verdict, 'unplanned');
  // only the fault is needed to reproduce the unplanned verdict at the midpoint
  assert.deepEqual(d.minimalSubset.map((e) => e.id), ['f']);
  assert.equal(d.oneMinimal, true);
  // the subset alone really reproduces the verdict
  const repro = analyze({ events: d.minimalSubset });
  const seg = repro.timeline.find((s) => s.start <= 2000 && 2000 < s.end);
  assert.equal(seg.planned, false);
  // minimal flip: shrink the fault off the disputed interval -> run underneath is planned
  assert.deepEqual(d.flip, { deletions: [], shrinks: [{ id: 'f', start: 0, end: 1000 }] });
});

test('flip by deletion when the fault exactly matches the disputed interval', () => {
  const events = [
    { id: 'r', type: 'run', start: 0, end: 4000 },
    { id: 'f', type: 'fault', start: 1000, end: 3000 },
  ];
  const d = dispute({ events, interval: { start: 1000, end: 3000 } });
  assert.equal(d.verdict, 'unplanned');
  assert.deepEqual(d.flip, { deletions: ['f'], shrinks: [] });
  // applying the flip makes the interval planned
  const after = analyze({ events: events.filter((e) => e.id !== 'f') });
  const seg = after.timeline.find((s) => s.start <= 2000 && 2000 < s.end);
  assert.equal(seg.planned, true);
});

test('flip falls back to deletion pairs when singles do not suffice', () => {
  const events = [
    { id: 'r', type: 'run', start: 0, end: 10_000 },
    { id: 'f1', type: 'fault', start: 0, end: 5000 },
    { id: 'f2', type: 'fault', start: 1000, end: 3000 },
  ];
  const d = dispute({ events, interval: { start: 1000, end: 3000 } });
  assert.equal(d.verdict, 'unplanned');
  assert.deepEqual(d.flip.deletions.sort(), ['f1', 'f2']);
});

test('planned segment dispute: verdict planned, no flip needed', () => {
  const events = [{ id: 'm', type: 'maintenance', start: 0, end: 1000 }];
  const d = dispute({ events, interval: { start: 0, end: 1000 } });
  assert.equal(d.verdict, 'planned');
  assert.equal(d.flip, null);
});

test('dispute outside observation window -> ERR_SCHEMA', () => {
  const d = dispute({ events: [{ id: 'r', type: 'run', start: 0, end: 100 }], interval: { start: 500, end: 600 } });
  assert.equal(d.ok, false);
  assert.equal(d.error.code, 'ERR_SCHEMA');
});

test('unplanned-by-threshold dispute: reason proves why (changeover over budget)', () => {
  const events = [{ id: 'c', type: 'changeover', start: 0, end: 3_600_000 }];
  const a = analyze({ events });
  assert.equal(a.timeline[0].planned, false);
  assert.match(a.timeline[0].reason, /3600000ms > budget 1800000ms -> unplanned/);
  const d = dispute({ events, interval: { start: 0, end: 3_600_000 } });
  assert.equal(d.verdict, 'unplanned');
  assert.deepEqual(d.minimalSubset.map((e) => e.id), ['c']);
});
