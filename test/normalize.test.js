import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyze.js';

test('empty stream yields empty timeline and null OEE, not an error', () => {
  const cert = analyze([]);
  assert.deepEqual(cert.timeline, []);
  assert.equal(cert.oee.windowMs, 0);
  assert.equal(cert.oee.availability, null);
  assert.equal(cert.oee.oee, null);
});

test('adjacent same-timestamp events produce contiguous intervals without gaps', () => {
  const cert = analyze([
    { id: 'a', type: 'run', start: 0, end: 100 },
    { id: 'b', type: 'fault', start: 100, end: 200 },
    { id: 'c', type: 'run', start: 200, end: 300 },
  ]);
  assert.deepEqual(
    cert.timeline.map((iv) => [iv.start, iv.end, iv.state]),
    [
      [0, 100, 'run'],
      [100, 200, 'fault'],
      [200, 300, 'run'],
    ],
  );
  assert.ok(cert.timeline.every((iv) => iv.durationMs > 0));
});

test('out-of-order and overlapping events normalize to atomic intervals', () => {
  const cert = analyze([
    { id: 'b', type: 'idle', start: 50, end: 150 },
    { id: 'a', type: 'run', start: 0, end: 100 },
  ]);
  assert.deepEqual(
    cert.timeline.map((iv) => [iv.start, iv.end, iv.state]),
    [
      [0, 50, 'run'],
      [50, 100, 'idle'],
      [100, 150, 'idle'],
    ],
  );
  assert.deepEqual(cert.timeline[1].coveringEventIds, ['a', 'b']);
});

test('gaps between events are reported as uncovered', () => {
  const cert = analyze([
    { id: 'a', type: 'run', start: 0, end: 100 },
    { id: 'b', type: 'run', start: 200, end: 300 },
  ]);
  const gap = cert.timeline.find((iv) => iv.state === 'uncovered');
  assert.deepEqual([gap.start, gap.end], [100, 200]);
  assert.equal(cert.oee.uncoveredMs, 100);
});

test('all-day planned maintenance: planned downtime, no production time, null OEE', () => {
  const day = 24 * 60 * 60 * 1000;
  const cert = analyze([{ id: 'pm', type: 'maintenance', start: 0, end: day }]);
  assert.equal(cert.timeline.length, 1);
  assert.equal(cert.timeline[0].planned, true);
  assert.equal(cert.timeline[0].rule, 'maintenance-planned');
  assert.equal(cert.oee.plannedDowntimeMs, day);
  assert.equal(cert.oee.plannedProductionTimeMs, 0);
  assert.equal(cert.oee.availability, null);
  assert.equal(cert.oee.oee, null);
});
