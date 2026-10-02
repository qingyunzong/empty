import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, AuditError } from '../src/engine.js';
import { runAudit } from '../src/audit.js';

const T = (min) => `2026-01-01T00:${String(min).padStart(2, '0')}:00Z`;

// Acceptance 4: negative kwh boundary and rollback detection.
test('negative cumulative kwh is rejected as METER_ROLLBACK', () => {
  const engine = new Engine();
  engine.apply({ type: 'meter', eventTs: T(0), meter: 'M1', kwh: 100, estimated: false });
  assert.throws(
    () => engine.apply({ type: 'meter', eventTs: T(15), meter: 'M1', kwh: -1, estimated: false }),
    (err) => err instanceof AuditError && err.code === 'METER_ROLLBACK',
  );
});

test('zero kwh boundary is accepted (meter install / reset baseline)', () => {
  const engine = new Engine();
  engine.apply({ type: 'meter', eventTs: T(0), meter: 'M1', kwh: 0, estimated: false });
  engine.apply({ type: 'meter', eventTs: T(15), meter: 'M1', kwh: 0, estimated: false });
  const windows = engine.finalize();
  assert.equal(windows.length, 0); // no consumption, no windows
});

test('kwh decrease without retract reports METER_ROLLBACK', () => {
  const engine = new Engine();
  engine.apply({ type: 'meter', eventTs: T(0), meter: 'M1', kwh: 100, estimated: false });
  engine.apply({ type: 'meter', eventTs: T(15), meter: 'M1', kwh: 200, estimated: false });
  assert.throws(
    () => engine.apply({ type: 'meter', eventTs: T(30), meter: 'M1', kwh: 150, estimated: false }),
    (err) => err.code === 'METER_ROLLBACK' && err.message.includes('not a retract'),
  );
});

test('out-of-order insert that breaks monotonicity reports METER_ROLLBACK', () => {
  const engine = new Engine();
  engine.apply({ type: 'meter', eventTs: T(0), meter: 'M1', kwh: 100, estimated: false });
  engine.apply({ type: 'meter', eventTs: T(30), meter: 'M1', kwh: 200, estimated: false });
  assert.throws(
    () => engine.apply({ type: 'meter', eventTs: T(15), meter: 'M1', kwh: 250, estimated: false }),
    (err) => err.code === 'METER_ROLLBACK',
  );
});

test('retract first, then lower reading is accepted and corrects the window', () => {
  const events = [
    { type: 'meter', eventTs: T(0), meter: 'M1', kwh: 100, estimated: false },
    { type: 'meter', eventTs: T(15), meter: 'M1', kwh: 200, estimated: true },
    { type: 'retract', eventTs: T(16), kind: 'meter', id: `M1@${new Date(T(15)).toISOString()}` },
    { type: 'meter', eventTs: T(15), meter: 'M1', kwh: 120, estimated: false },
  ];
  const { windows, settlement } = runAudit(events);
  assert.equal(windows[0].kwh, 20);
  assert.equal(settlement.peak.grossKw, 80);
});

test('failed rollback insert leaves previous state intact', () => {
  const engine = new Engine();
  engine.apply({ type: 'meter', eventTs: T(0), meter: 'M1', kwh: 100, estimated: false });
  engine.apply({ type: 'meter', eventTs: T(15), meter: 'M1', kwh: 200, estimated: false });
  assert.throws(() => engine.apply(
    { type: 'meter', eventTs: T(30), meter: 'M1', kwh: 50, estimated: false }));
  const windows = engine.finalize();
  assert.equal(windows.length, 1);
  assert.equal(windows[0].kwh, 100);
});
