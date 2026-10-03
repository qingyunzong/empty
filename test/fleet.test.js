import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fleet } from '../src/fleet.js';

const config = {
  sitePowerKw: 100,
  cutoffTs: 100,
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

function ingestAll(events) {
  const fleet = new Fleet(config);
  events.forEach((ev, i) => fleet.ingest(ev, i + 1));
  return fleet;
}

test('out-of-order request/release events merge to the same final result', () => {
  const inOrder = [req('e1', 'V1', 1, 10, 120, 50), rel('e2', 'V1', 2, 90), req('e3', 'V2', 1, 20, 40, 50), req('e4', 'V3', 1, 30, 30, 50)];
  const shuffled = [inOrder[3], inOrder[1], inOrder[0], inOrder[2]];
  const a = ingestAll(inOrder).report();
  const b = ingestAll(shuffled).report();
  assert.deepEqual(b.timeline, a.timeline);
  assert.deepEqual(b.bills, a.bills);
  // expected merged timeline: V1 10-90 released, V2 20-60 completed, V3 waits for C2 then 60-90
  assert.deepEqual(
    a.timeline.map((s) => [s.vehicleId, s.startTs, s.endTs, s.endReason]),
    [
      ['V1', 10, 90, 'released'],
      ['V2', 20, 60, 'completed'],
      ['V3', 60, 90, 'completed'],
    ],
  );
  assert.equal(a.bills.tenants.T1.minutes, 120); // V1 80 + V2 40
});

test('emergency preempts, keeps charged energy, and aging reorders the queue', () => {
  const single = {
    ...config,
    sitePowerKw: 60,
    chargers: [{ id: 'C1', maxPowerKw: 60 }],
    tenants: { T1: { dailyMinutesCap: 1000 } },
    vehicles: { V1: { tenantId: 'T1' }, V2: { tenantId: 'T1' }, V3: { tenantId: 'T1' } },
  };
  const fleet = new Fleet(single);
  fleet.ingest(req('e1', 'V1', 1, 0, 60, 50), 1); // normal, starts at 0
  fleet.ingest(req('e2', 'V2', 1, 10, 30, 50, 'emergency'), 2); // preempts V1 at t=10
  fleet.ingest(req('e3', 'V3', 1, 15, 20, 50), 3); // normal, waits behind aged V1
  const r = fleet.report();
  assert.deepEqual(
    r.timeline.map((s) => [s.vehicleId, s.startTs, s.endTs, s.endReason]),
    [
      ['V1', 0, 10, 'preempted'], // keeps 10 minutes of charge
      ['V2', 10, 40, 'completed'], // emergency takes the slot
      ['V1', 40, 90, 'completed'], // aged V1 (waitSince 0) beats V3 (waitSince 15)
      ['V3', 90, 110, 'completed'],
    ],
  );
  assert.equal(r.bills.vehicles.V1.minutes, 60); // 10 kept + 50 remaining
  assert.equal(r.bills.vehicles.V1.energyKwh, 50);
});

test('late event before cutoff recomputes and issues a reversal certificate', () => {
  const fleet = new Fleet(config);
  fleet.ingest(req('e1', 'V1', 1, 10, 60, 50), 1);
  const before = fleet.report();
  assert.equal(before.bills.vehicles.V1.minutes, 60); // would charge 10..70
  fleet.ingest(rel('e2', 'V1', 2, 20), 2); // late release, still before cutoff
  const after = fleet.report();
  assert.equal(after.bills.vehicles.V1.minutes, 10); // recomputed: charged 10..20
  assert.equal(after.reversals.length, 2);
  const rev = after.reversals.at(-1);
  assert.equal(rev.certificateId, 'REV-2');
  assert.equal(rev.triggerEventId, 'e2');
  assert.deepEqual(
    rev.diffs.find((d) => d.scope === 'vehicle' && d.id === 'V1' && d.field === 'minutes'),
    { scope: 'vehicle', id: 'V1', field: 'minutes', before: 60, after: 10, delta: -50 },
  );
});

test('event arriving after cutoff is rejected and settled bills do not change', () => {
  const fleet = new Fleet(config);
  fleet.ingest(req('e1', 'V1', 1, 10, 60, 50), 1);
  fleet.ingest(rel('e2', 'V1', 2, 40), 2);
  const settled = fleet.report();
  assert.equal(settled.bills.vehicles.V1.minutes, 30);

  const res = fleet.ingest(req('e3', 'V2', 1, 20, 45, 50), 150); // arrival after cutoffTs=100
  assert.deepEqual(res, { status: 'rejected', reason: 'after_cutoff' });

  const after = fleet.report();
  assert.deepEqual(after.timeline, settled.timeline);
  assert.deepEqual(after.bills, settled.bills);
  assert.equal(after.reversals.length, settled.reversals.length);
  assert.ok(after.rejections.some((r) => r.eventId === 'e3' && r.reason === 'after_cutoff'));
});

test('excess power, duplicate events and unknown vehicles are rejected', () => {
  const fleet = new Fleet(config);
  assert.equal(fleet.ingest(req('e1', 'V1', 1, 0, 30, 200), 1).reason, 'excess_power'); // > site 100
  assert.equal(fleet.ingest(req('e2', 'V1', 1, 0, 30, 80), 2).reason, 'excess_power'); // > max charger 60
  assert.equal(fleet.ingest(req('e3', 'VX', 1, 0, 30, 50), 3).reason, 'unknown_vehicle');

  assert.equal(fleet.ingest(req('e4', 'V1', 1, 0, 30, 50), 4).status, 'accepted');
  assert.equal(fleet.ingest(req('e4', 'V1', 2, 1, 30, 50), 5).reason, 'duplicate_event'); // same eventId
  assert.equal(fleet.ingest(req('e5', 'V1', 1, 2, 30, 50), 6).reason, 'duplicate_event'); // same vehicleId+seq

  const reasons = fleet.report().rejections.map((r) => r.reason);
  assert.deepEqual(reasons, ['excess_power', 'excess_power', 'unknown_vehicle', 'duplicate_event', 'duplicate_event']);
});

test('recomputation keeps tenant quota, charger exclusion and completed records consistent', () => {
  const fleet = new Fleet(config);
  const events = [
    req('e1', 'V1', 1, 0, 45, 50),
    req('e2', 'V2', 1, 5, 45, 50),
    req('e3', 'V3', 1, 10, 45, 50),
    rel('e4', 'V1', 2, 25),
  ];
  events.forEach((ev, i) => fleet.ingest(ev, i + 1));
  const r = fleet.report();
  // tenant quota
  for (const [tid, t] of Object.entries(r.bills.tenants)) {
    assert.ok(t.minutes <= config.tenants[tid].dailyMinutesCap, `${tid} over cap`);
  }
  // charger mutual exclusion
  for (const c of config.chargers) {
    const segs = r.timeline.filter((s) => s.chargerId === c.id).sort((a, b) => a.startTs - b.startTs);
    for (let i = 1; i < segs.length; i++) assert.ok(segs[i].startTs >= segs[i - 1].endTs);
  }
  // completed records: per-vehicle bills equal the sum of their timeline segments
  for (const [vid, bill] of Object.entries(r.bills.vehicles)) {
    const sum = r.timeline.filter((s) => s.vehicleId === vid).reduce((n, s) => n + s.minutes, 0);
    assert.equal(bill.minutes, sum);
  }
});
