import test from 'node:test';
import assert from 'node:assert/strict';
import { runAudit } from '../src/audit.js';

const T = (min) => `2026-01-01T00:${String(min).padStart(2, '0')}:00Z`;

// Acceptance 1: replacing an estimated reading with a lower actual reading
// retracts the estimate and lowers the demand peak incrementally.
test('estimated reading replaced by actual lowers the peak', () => {
  const prefix = [
    { type: 'meter', eventTs: T(0), meter: 'M1', kwh: 1000, estimated: false },
    { type: 'meter', eventTs: T(15), meter: 'M1', kwh: 1100, estimated: true },
    { type: 'meter', eventTs: T(30), meter: 'M1', kwh: 1100, estimated: false },
  ];
  const before = runAudit(prefix);
  assert.equal(before.settlement.peak.grossKw, 400); // 100 kWh in window 0

  const corrections = [
    // late corrections: event time is below the watermark (00:29)
    { type: 'retract', eventTs: T(20), kind: 'meter', id: `M1@${new Date(T(15)).toISOString()}` },
    { type: 'meter', eventTs: T(20), meter: 'M1', kwh: 1030, estimated: false },
  ];
  // The replacement reading belongs to the same (meter, eventTs) as the retracted one:
  // re-add it at the original reading timestamp after the retract.
  const after = runAudit([
    ...prefix,
    corrections[0],
    { ...corrections[1], eventTs: T(15) },
  ]);

  assert.equal(after.settlement.peak.grossKw, 280); // max(30*4, 70*4)
  assert.ok(after.settlement.peak.grossKw < before.settlement.peak.grossKw);

  const w0 = after.windows.find((w) => w.windowStart === new Date(T(0)).toISOString());
  const w1 = after.windows.find((w) => w.windowStart === new Date(T(15)).toISOString());
  assert.equal(w0.kwh, 30);
  assert.equal(w1.kwh, 70);
  assert.equal(w0.estimated, false); // estimate withdrawn

  // correction journal + late log
  assert.equal(after.settlement.corrections, 1); // the retract; re-insert is a fresh reading
  assert.ok(after.comp.some((c) => c.type === 'meter_retract' && c.meter === 'M1'));
  assert.ok(after.late.length >= 1);
  assert.ok(after.late.every((l) => l.reason.includes('watermark')));
});

test('upsert at same (meter, eventTs) acts as in-place correction, not rollback', () => {
  const events = [
    { type: 'meter', eventTs: T(0), meter: 'M1', kwh: 500, estimated: false },
    { type: 'meter', eventTs: T(15), meter: 'M1', kwh: 900, estimated: true },
    { type: 'meter', eventTs: T(15), meter: 'M1', kwh: 600, estimated: false }, // correction
  ];
  const { settlement, windows, comp } = runAudit(events);
  assert.equal(windows[0].kwh, 100);
  assert.equal(settlement.peak.grossKw, 400);
  assert.ok(comp.some((c) => c.type === 'meter_correction' && c.from.kwh === 900 && c.to.kwh === 600));
});
