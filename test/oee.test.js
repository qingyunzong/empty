import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyze.js';

test('basic availability and OEE computation', () => {
  const cert = analyze([
    { id: 'a', type: 'run', start: 0, end: 100 },
    { id: 'b', type: 'fault', start: 100, end: 200 },
  ]);
  assert.equal(cert.oee.windowMs, 200);
  assert.equal(cert.oee.runMs, 100);
  assert.equal(cert.oee.unplannedDowntimeMs, 100);
  assert.equal(cert.oee.plannedProductionTimeMs, 200);
  assert.equal(cert.oee.availability, 0.5);
  assert.equal(cert.oee.oee, 0.5);
});

test('performance and quality factors multiply into OEE', () => {
  const cert = analyze(
    [{ id: 'a', type: 'run', start: 0, end: 100 }],
    { performance: 0.9, quality: 0.8 },
  );
  assert.equal(cert.oee.availability, 1);
  assert.ok(Math.abs(cert.oee.oee - 0.72) < 1e-12);
});

test('injected duplicate fault does not deduct OEE twice', () => {
  const events = [
    { id: 'a', type: 'run', start: 0, end: 100 },
    { id: 'f', type: 'fault', start: 100, end: 200 },
  ];
  const clean = analyze(events);
  const injected = analyze(events, {}, { injection: { spec: { duplicate: [{ id: 'f', times: 3 }] } } });
  assert.equal(injected.input.eventCount, 5);
  assert.equal(injected.oee.unplannedDowntimeMs, clean.oee.unplannedDowntimeMs);
  assert.equal(injected.oee.availability, clean.oee.availability);
  assert.equal(injected.oee.oee, clean.oee.oee);
  assert.equal(injected.injection.replayVerified, true);
});

test('uncovered time can be configured to count as unplanned', () => {
  const events = [{ id: 'a', type: 'run', start: 0, end: 100 }];
  const excluded = analyze(events);
  assert.equal(excluded.oee.availability, 1);
  const counted = analyze(
    [
      { id: 'a', type: 'run', start: 0, end: 100 },
      { id: 'b', type: 'run', start: 200, end: 300 },
    ],
    { uncovered: 'unplanned' },
  );
  assert.equal(counted.oee.uncoveredMs, 100);
  assert.equal(counted.oee.availability, 200 / 300);
});
