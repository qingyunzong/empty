import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from '../src/engine.js';

const baseConfig = {
  sitePowerKw: 100,
  chargers: [
    { id: 'C1', maxPowerKw: 60 },
    { id: 'C2', maxPowerKw: 60 },
  ],
  tenants: { T1: { dailyMinutesCap: 500 }, T2: { dailyMinutesCap: 500 } },
  vehicles: {
    V1: { tenantId: 'T1' },
    V2: { tenantId: 'T1' },
    V3: { tenantId: 'T2' },
  },
};

const req = (eventId, vehicleId, seq, ts, minutes, powerKw, priority) => ({
  eventId, vehicleId, seq, ts, type: 'charge_request', minutes, powerKw, priority,
});
const rel = (eventId, vehicleId, seq, ts) => ({
  eventId, vehicleId, seq, ts, type: 'charge_release',
});

function maxConcurrentPowerKw(timeline) {
  const points = [...new Set(timeline.flatMap((s) => [s.startTs, s.endTs]))].sort((a, b) => a - b);
  let max = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const mid = (points[i] + points[i + 1]) / 2;
    const power = timeline
      .filter((s) => s.startTs <= mid && mid < s.endTs)
      .reduce((sum, s) => sum + s.powerKw, 0);
    max = Math.max(max, power);
  }
  return max;
}

test('site power quota is never exceeded', () => {
  const events = [
    req('e1', 'V1', 1, 0, 120, 40),
    req('e2', 'V2', 1, 5, 120, 40),
    req('e3', 'V3', 1, 10, 120, 40),
  ];
  const r = simulate(events, baseConfig);
  assert.ok(maxConcurrentPowerKw(r.timeline) <= baseConfig.sitePowerKw);
  // two 40kW vehicles fit under the 100kW site cap; the third waits
  assert.equal(r.timeline.length, 3);
  assert.equal(r.timeline[2].startTs, 120);
});

test('charger mutual exclusion: segments on one charger never overlap', () => {
  const events = [req('e1', 'V1', 1, 0, 50, 40), req('e2', 'V2', 1, 3, 50, 40), req('e3', 'V3', 1, 6, 50, 40)];
  const r = simulate(events, baseConfig);
  for (const charger of baseConfig.chargers) {
    const segs = r.timeline.filter((s) => s.chargerId === charger.id).sort((a, b) => a.startTs - b.startTs);
    for (let i = 1; i < segs.length; i++) {
      assert.ok(segs[i].startTs >= segs[i - 1].endTs, `overlap on ${charger.id}`);
    }
  }
});

test('tenant daily minutes cap is enforced, remainder stays unscheduled', () => {
  const config = {
    ...baseConfig,
    tenants: { T1: { dailyMinutesCap: 30 } },
    vehicles: { V1: { tenantId: 'T1' } },
  };
  const r = simulate([req('e1', 'V1', 1, 0, 60, 50)], config);
  assert.equal(r.bills.tenants.T1.minutes, 30);
  assert.equal(r.timeline[0].endReason, 'tenant_cap');
  assert.deepEqual(r.unscheduled, [{ vehicleId: 'V1', tenantId: 'T1', remainingMin: 30, waitSince: 0 }]);
});

test('release stops charging and frees the slot for the waiting queue', () => {
  const events = [
    req('e1', 'V1', 1, 0, 100, 60),
    req('e2', 'V2', 1, 5, 40, 60),
    rel('e3', 'V1', 2, 20),
  ];
  const r = simulate(events, baseConfig);
  assert.deepEqual(
    r.timeline.map((s) => [s.vehicleId, s.startTs, s.endTs, s.endReason]),
    [
      ['V1', 0, 20, 'released'],
      ['V2', 20, 60, 'completed'],
    ],
  );
});

test('release without an active or pending charge is rejected by the engine', () => {
  const r = simulate([rel('e1', 'V1', 1, 10)], baseConfig);
  assert.equal(r.timeline.length, 0);
  assert.deepEqual(r.rejections, [{ eventId: 'e1', vehicleId: 'V1', ts: 10, reason: 'release_without_charge' }]);
});
