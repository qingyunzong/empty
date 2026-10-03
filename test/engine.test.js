import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../src/engine.js';

const ev = (id, ts, kind, payload = {}, extra = {}) => ({ id, ts, device: 'D1', lot: 'L1', kind, payload, ...extra });

test('out-of-order delivery is reordered by (ts, id)', () => {
  const engine = createEngine();
  const report = engine.ingestBatch([
    ev('e3', 3000, 'quality.release'),
    ev('e1', 1000, 'quality.hold'),
    ev('e2', 2000, 'device.alarm'),
  ]);
  assert.deepEqual(report.applied, ['e1', 'e2', 'e3']);
  assert.equal(report.rejected.length, 0);
  const cert = engine.cert('L1');
  assert.equal(cert.quality, 'released');
  assert.equal(cert.devices.D1.status, 'alarming');
});

test('duplicates are idempotent', () => {
  const engine = createEngine();
  engine.ingestBatch([ev('e1', 1000, 'quality.hold')]);
  const report = engine.ingestBatch([ev('e1', 1000, 'quality.hold')]);
  assert.deepEqual(report.duplicates, ['e1']);
  assert.equal(report.applied.length, 0);
  assert.equal(engine.cert('L1').applied.length, 1);
});

test('late events beyond the out-of-order window are flagged but still applied', () => {
  const engine = createEngine({ windowMs: 1000 });
  engine.ingestBatch([ev('e1', 10000, 'device.alarm')]);
  const report = engine.ingestBatch([ev('e2', 5000, 'quality.hold')]);
  assert.deepEqual(report.late, ['e2']);
  assert.deepEqual(report.applied, ['e2']);
  assert.equal(engine.watermark, 10000);
});

test('illegal transitions report VALIDATION', () => {
  const engine = createEngine();
  let report = engine.ingestBatch([ev('e1', 1000, 'quality.release')]);
  assert.equal(report.rejected.length, 1);
  assert.match(report.rejected[0].error, /without hold/);
  report = engine.ingestBatch([ev('e2', 2000, 'device.clear')]);
  assert.equal(report.rejected.length, 1);
  report = engine.ingestBatch([ev('e3', 3000, 'quality.hold'), ev('e4', 4000, 'quality.hold')]);
  assert.deepEqual(report.applied, ['e3']);
  assert.equal(report.rejected.length, 1);
});

test('malformed events are rejected as VALIDATION-class errors', () => {
  const engine = createEngine();
  const report = engine.ingestBatch([
    { id: '', ts: 1, device: 'D1', lot: 'L1', kind: 'quality.hold' },
    { id: 'x', ts: 'nope', device: 'D1', lot: 'L1', kind: 'quality.hold' },
    { id: 'y', ts: 1, device: 'D1', lot: 'L1', kind: 'bogus.kind' },
  ]);
  assert.equal(report.malformed.length, 3);
  assert.equal(report.applied.length, 0);
});
