import test from 'node:test';
import assert from 'node:assert/strict';
import { runAudit } from '../src/audit.js';

const T = (min) => `2026-01-01T00:${String(min).padStart(2, '0')}:00Z`;

const meterEvents = [
  { type: 'meter', eventTs: T(0), meter: 'M1', kwh: 0, estimated: false },
  { type: 'meter', eventTs: T(15), meter: 'M1', kwh: 25, estimated: false },
  { type: 'meter', eventTs: T(30), meter: 'M1', kwh: 50, estimated: false },
];
const shedEvents = [
  { type: 'shed', eventTs: T(14), load: 'HVAC', kw: 40 },
  { type: 'shed', eventTs: T(29), load: 'Compressor', kw: 40 },
];
const tariff = (name, startMin, endMin, rate) => ({
  type: 'tariff', eventTs: T(0), name, start: T(startMin), end: T(endMin), rate,
});

// Acceptance 2: retracting a tariff recomputes cost and changes the optimal
// shed plan, while physically executed shed records stay untouched.
test('tariff retract changes the optimal shed plan', () => {
  const before = runAudit([
    ...meterEvents, ...shedEvents,
    tariff('w0', 0, 15, 2),
    tariff('w1', 15, 30, 1),
  ]);
  assert.equal(before.settlement.optimal.demandCost, 120);
  assert.deepEqual(before.settlement.optimal.plan, [
    { windowStart: new Date(T(0)).toISOString(), load: 'HVAC', kw: 40 },
  ]);

  const after = runAudit([
    ...meterEvents, ...shedEvents,
    tariff('w0', 0, 15, 2),
    tariff('w1', 15, 30, 1),
    { type: 'retract', eventTs: T(31), kind: 'tariff', id: 'w0' },
    { type: 'retract', eventTs: T(31), kind: 'tariff', id: 'w1' },
    { ...tariff('w0', 0, 15, 1), eventTs: T(31) },
    { ...tariff('w1', 15, 30, 2), eventTs: T(31) },
  ]);
  assert.equal(after.settlement.optimal.demandCost, 120);
  assert.deepEqual(after.settlement.optimal.plan, [
    { windowStart: new Date(T(15)).toISOString(), load: 'Compressor', kw: 40 },
  ]);

  // physical shed records unchanged; retraction only appended to comp journal
  const shedKwTotal = after.windows.reduce((acc, w) => acc + w.shedKw, 0);
  assert.equal(shedKwTotal, 80);
  assert.equal(after.settlement.executed.totalShedKw, 80);
  const retracts = after.comp.filter((c) => c.type === 'tariff_retract');
  assert.equal(retracts.length, 2);
  assert.ok(retracts.every((c) => c.note.includes('physical shed unchanged')));
});

test('shed retract keeps executed record and appends compensation', () => {
  const shedId = `HVAC@${new Date(T(14)).getTime()}`;
  const { windows, comp } = runAudit([
    ...meterEvents,
    { type: 'shed', eventTs: T(14), load: 'HVAC', kw: 40 },
    { type: 'retract', eventTs: T(20), kind: 'shed', id: shedId },
  ]);
  const w0 = windows.find((w) => w.shed.length > 0);
  assert.equal(w0.shedKw, 40); // still physically executed
  const compRec = comp.find((c) => c.type === 'shed_compensation');
  assert.ok(compRec);
  assert.equal(compRec.kw, 40);
  assert.ok(compRec.note.includes('physical record kept'));
});
