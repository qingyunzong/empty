import { test } from 'node:test';
import assert from 'node:assert/strict';
import { permutations, verifyOrderInvariance } from '../src/permute.js';

const config = {
  sitePowerKw: 100,
  cutoffTs: 1000,
  chargers: [
    { id: 'C1', maxPowerKw: 60 },
    { id: 'C2', maxPowerKw: 60 },
  ],
  tenants: { T1: { dailyMinutesCap: 500 }, T2: { dailyMinutesCap: 300 } },
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

test('permutations generator yields n! distinct orderings', () => {
  const perms = [...permutations([1, 2, 3, 4])];
  assert.equal(perms.length, 24);
  assert.equal(new Set(perms.map((p) => p.join(','))).size, 24);
});

test('6 events (requests + releases): all 720 legal arrival orders converge', () => {
  const events = [
    req('e1', 'V1', 1, 10, 90, 50),
    rel('e2', 'V1', 2, 70),
    req('e3', 'V2', 1, 20, 40, 50),
    rel('e4', 'V2', 2, 55),
    req('e5', 'V3', 1, 30, 30, 50),
    rel('e6', 'V3', 2, 80),
  ];
  const r = verifyOrderInvariance(config, events);
  assert.equal(r.checked, 720);
  assert.ok(r.ok, `mismatch: ${r.actual} vs ${r.expected}`);
});

test('5 events with emergency preemption: all 120 arrival orders converge', () => {
  const single = {
    ...config,
    sitePowerKw: 60,
    chargers: [{ id: 'C1', maxPowerKw: 60 }],
    tenants: { T1: { dailyMinutesCap: 1000 } },
    vehicles: { V1: { tenantId: 'T1' }, V2: { tenantId: 'T1' }, V3: { tenantId: 'T1' } },
  };
  const events = [
    req('e1', 'V1', 1, 0, 60, 50),
    req('e2', 'V2', 1, 10, 30, 50, 'emergency'),
    req('e3', 'V3', 1, 15, 20, 50),
    rel('e4', 'V3', 2, 100),
    rel('e5', 'V1', 2, 200),
  ];
  const r = verifyOrderInvariance(single, events);
  assert.equal(r.checked, 120);
  assert.ok(r.ok, `mismatch: ${r.actual} vs ${r.expected}`);
});

test('enumeration refuses more than 6 events', () => {
  const events = Array.from({ length: 7 }, (_, i) => req(`e${i}`, 'V1', i + 1, i, 5, 10));
  assert.throws(() => verifyOrderInvariance(config, events), /<= 6 events/);
});
