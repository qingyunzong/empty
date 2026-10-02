import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAudit, runAuditText, AuditError } from '../src/audit.js';

const T0 = Date.parse('2026-01-05T00:00:00Z');
const iso = (min) => new Date(T0 + min * 60000).toISOString();

const meter = (id, min, kwh, estimated = false) =>
  JSON.stringify({ type: 'meter', id, eventTs: iso(min), meter: 'M1', kwh, estimated });
const tariff = (id, name, startMin, endMin, rate) =>
  JSON.stringify({ type: 'tariff', id, eventTs: iso(startMin), name, start: iso(startMin), end: iso(endMin), rate });
const shed = (id, min, load, kw) =>
  JSON.stringify({ type: 'shed', id, eventTs: iso(min), load, kw });
const retract = (min, kind, id) => JSON.stringify({ type: 'retract', eventTs: iso(min), kind, id });

test('acceptance 1: estimated reading replaced by actual lowers the peak', () => {
  const base = [meter('r0', 0, 100), meter('r1', 15, 160, true)];
  const estimatedOnly = runAudit(base);
  assert.equal(estimatedOnly.windows.length, 1);
  assert.equal(estimatedOnly.windows[0].kwh, 60);
  assert.equal(estimatedOnly.windows[0].demandKw, 240);
  assert.equal(estimatedOnly.windows[0].estimated, true);
  assert.equal(estimatedOnly.settlement.peak.demandKw, 240);

  const corrected = runAudit([...base, retract(20, 'meter', 'r1'), meter('r2', 15, 130)]);
  assert.equal(corrected.windows.length, 1);
  assert.equal(corrected.windows[0].kwh, 30);
  assert.equal(corrected.windows[0].demandKw, 120);
  assert.equal(corrected.windows[0].estimated, false);
  assert.equal(corrected.settlement.peak.demandKw, 120);
  assert.ok(corrected.settlement.peak.demandKw < estimatedOnly.settlement.peak.demandKw);
});

test('acceptance 2: tariff retraction recomputes cost and changes the optimal shed plan', () => {
  const common = [
    // metered demand: w0 = 90 kW, w1 = 70 kW
    meter('r0', 0, 100),
    meter('r1', 15, 122.5),
    meter('r2', 30, 140),
    // executed sheds: A(10) in w0, B(20) in w1 -> baselines w0=100, w1=90
    shed('s1', 5, 'A', 10),
    shed('s2', 16, 'B', 20),
  ];
  const before = runAudit([...common, tariff('t1', 'flat', 0, 30, 10)]);
  assert.equal(before.windows[0].baselineKw, 100);
  assert.equal(before.windows[1].baselineKw, 90);
  assert.equal(before.settlement.optimal.method, 'exhaustive');
  // flat rate: push both windows down to 70 kW -> cost 700, shed 50
  assert.equal(before.settlement.optimal.cost, 700);
  assert.equal(before.settlement.optimal.totalShedKw, 50);
  assert.deepEqual(before.settlement.optimal.plans, [
    [
      { windowStart: iso(0), load: 'A', kw: 10 },
      { windowStart: iso(0), load: 'B', kw: 20 },
      { windowStart: iso(15), load: 'B', kw: 20 },
    ],
  ]);

  const after = runAudit([
    ...common,
    tariff('t1', 'flat', 0, 30, 10),
    retract(31, 'tariff', 't1'),
    tariff('t2', 'w0', 0, 15, 10),
    tariff('t3', 'w1-peak', 15, 30, 100),
  ]);
  // physical executed shed is unchanged by the tariff retraction
  assert.deepEqual(after.settlement.executed.plan, before.settlement.executed.plan);
  // but the optimal plan moved entirely into the expensive window
  assert.equal(after.settlement.optimal.cost, 6000);
  assert.equal(after.settlement.optimal.totalShedKw, 30);
  assert.deepEqual(after.settlement.optimal.plans, [
    [
      { windowStart: iso(15), load: 'A', kw: 10 },
      { windowStart: iso(15), load: 'B', kw: 20 },
    ],
  ]);
  assert.notDeepEqual(after.settlement.optimal.plans, before.settlement.optimal.plans);
});

test('shed retraction is forbidden: shed stays, compensation record appended', () => {
  const r = runAudit([
    meter('r0', 0, 100),
    meter('r1', 15, 110),
    shed('s1', 5, 'HVAC-1', 50),
    retract(20, 'shed', 's1'),
  ]);
  assert.equal(r.windows[0].shedKw, 50);
  assert.deepEqual(r.windows[0].sheds, [{ load: 'HVAC-1', kw: 50 }]);
  assert.equal(r.comp.length, 1);
  assert.equal(r.comp[0].reason, 'SHED_RETRACT_FORBIDDEN');
  assert.equal(r.comp[0].action, 'compensate');
  assert.equal(r.comp[0].id, 's1');
  assert.equal(r.comp[0].load, 'HVAC-1');
  assert.equal(r.comp[0].kw, 50);
});

test('watermark = max event time - 1 minute; out-of-order events go to late.log', () => {
  const r = runAudit([meter('r0', 0, 100), meter('r1', 61, 300), meter('r2', 15, 210)]);
  assert.equal(r.settlement.watermark, iso(60));
  assert.equal(r.late.length, 1);
  assert.equal(r.late[0].reason, 'late');
  // late event is still applied
  const w0 = r.windows.find((w) => w.windowStart === iso(0));
  assert.equal(w0.kwh, 110);
  // window ending at 00:15 is final, window ending at 01:15 is not
  assert.equal(w0.final, true);
  const w1 = r.windows.find((w) => w.windowStart === iso(60));
  assert.equal(w1.final, false);
});

test('malformed lines and unknown retracts are logged, not fatal', () => {
  const r = runAuditText(
    ['not json', '{"type":"meter"}', JSON.stringify({ type: 'retract', eventTs: iso(1), kind: 'meter', id: 'nope' }), meter('r0', 0, 5), meter('r1', 15, 10)].join(
      '\n',
    ),
  );
  const reasons = r.late.map((l) => l.reason);
  assert.ok(reasons.includes('bad_json'));
  assert.ok(reasons.includes('bad_eventTs'));
  assert.ok(reasons.includes('unknown_retract'));
  assert.equal(r.windows[0].kwh, 5);
});

test('multiple meters sum into the same window', () => {
  const lines = [
    JSON.stringify({ type: 'meter', id: 'a0', eventTs: iso(0), meter: 'A', kwh: 50 }),
    JSON.stringify({ type: 'meter', id: 'a1', eventTs: iso(15), meter: 'A', kwh: 60 }),
    JSON.stringify({ type: 'meter', id: 'b0', eventTs: iso(0), meter: 'B', kwh: 7 }),
    JSON.stringify({ type: 'meter', id: 'b1', eventTs: iso(15), meter: 'B', kwh: 12 }),
  ];
  const r = runAudit(lines);
  assert.equal(r.windows[0].kwh, 15);
  assert.equal(r.windows[0].demandKw, 60);
});
