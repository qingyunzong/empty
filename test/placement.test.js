'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore, applyEvent } = require('../src/biobank');
const { maxPlaceable } = require('../src/bruteforce');

// Acceptance 1: 20 mixed arrivals; for every prefix n <= 12 the number of
// placed samples must equal the brute-force optimum over the arrived set.
const config = {
  type: 'config',
  racks: [
    { id: 'R1', zone: '-80', capacity: 4 },
    { id: 'R2', zone: '-80', capacity: 4 },
    { id: 'R3', zone: '-40', capacity: 2 },
  ],
  quotas: { P1: 3, P2: 2 },
  aging: 1,
  freezeAfter: 0, // everything frozen immediately: no preemption in this test
};

const projects = ['P1', 'P1', 'P2', 'P1', 'P2', 'P1', 'P3', 'P1', 'P2', 'P1',
  'P2', 'P1', 'P3', 'P1', 'P2', 'P3', 'P1', 'P3', 'P2', 'P1'];
const zones = ['-80', '-80', '-80', '-80', '-80', '-80', '-40', '-80', '-80', '-80',
  '-80', '-80', '-40', '-80', '-80', '-40', '-80', '-80', '-80', '-80'];

const events = projects.map((project, i) => ({
  type: 'arrive',
  id: 'S' + String(i + 1).padStart(2, '0'),
  project,
  priority: (i * 7) % 5,
  zone: zones[i],
  arrival: i,
  deadline: 1000,
}));

test('20 mixed arrivals; placed count matches brute-force optimum for n<=12', () => {
  const store = createStore(config);
  let placed = 0;
  for (let n = 1; n <= events.length; n++) {
    const result = applyEvent(store, events[n - 1]);
    placed += result.placements.length - 0; // preemption disabled, none withdrawn
    if (n <= 12) {
      const optimum = maxPlaceable(store.config, events.slice(0, n));
      const placedNow = [...store.samples.values()].filter((s) => s.status === 'placed').length;
      assert.equal(placedNow, optimum, 'prefix n=' + n);
    }
  }
  assert.equal(placed, 8); // P1 quota 3 + P2 quota 2 + 3 unquotaed P3 samples
});

test('placement is deterministic across independent runs', () => {
  const runAll = () => {
    const store = createStore(config);
    return events.map((ev) => applyEvent(store, ev).hash);
  };
  assert.deepEqual(runAll(), runAll());
});

test('hard constraints: zone, capacity, adjacency, quota are never violated', () => {
  const store = createStore(config);
  for (const ev of events) applyEvent(store, ev);
  const counts = {};
  for (const s of store.samples.values()) {
    if (s.status !== 'placed') continue;
    counts[s.project] = (counts[s.project] || 0) + 1;
    const rack = store.racks.find((r) => r.id === s.rack);
    assert.equal(rack.zone, s.zone, 'zone mismatch for ' + s.id);
    assert.equal(rack.slots[s.slot], s.id);
    const mates = rack.slots
      .map((id, i) => ({ id, i }))
      .filter((x) => x.id && store.samples.get(x.id).project === s.project && x.id !== s.id);
    if (mates.length > 0) {
      assert.ok(mates.some((m) => Math.abs(m.i - s.slot) === 1), 'adjacency violated for ' + s.id);
    }
  }
  for (const [project, q] of Object.entries(config.quotas)) {
    assert.ok((counts[project] || 0) <= q, 'quota exceeded for ' + project);
  }
  for (const rack of store.racks) {
    assert.ok(rack.slots.filter((x) => x !== null).length <= rack.capacity);
  }
});
