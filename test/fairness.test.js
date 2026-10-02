import test from 'node:test';
import assert from 'node:assert/strict';
import {computeSchedule} from '../src/scheduler.js';

function slotWindows(station, slots) {
  return slots.map((i) => ({
    id: `${station}w${i}`, start: i, end: i + 1, cost: 1,
  }));
}

test('acceptance 2: starved station receives its floor (exact path)', () => {
  // Two slots on one shared link. C2's min is unreachable (3 > 2 slots), so
  // max-satisfied alone gives everything to C1. The floor rescues C2.
  const slots = [0, 1];
  const stations = [
    {id: 'S1', link: 'L', battery: 2, windows: slotWindows('S1', slots)},
    {id: 'S2', link: 'L', battery: 2, windows: slotWindows('S2', slots)},
  ];
  const withFloor = [
    {id: 'C1', station: 'S1', min: 2, floor: 0, period: 10, quota: 2},
    {id: 'C2', station: 'S2', min: 3, floor: 1, period: 10, quota: 2},
  ];
  const r = computeSchedule({stations, contracts: withFloor, fixed: []});
  assert.equal(r.counts.get('C2') || 0, 1, 'starved contract must get its floor');
  assert.equal(r.counts.get('C1') || 0, 1);

  const noFloor = withFloor.map((c) => ({...c, floor: 0}));
  const r2 = computeSchedule({stations, contracts: noFloor, fixed: []});
  assert.equal(r2.counts.get('C2') || 0, 0, 'without the floor C2 is starved');
  assert.equal(r2.counts.get('C1') || 0, 2);
});

test('acceptance 2: floor holds on greedy path (n>11)', () => {
  // C2's deficit (min=1) never beats C1's, and ties go to the lower station
  // id, so only the floor phase guarantees C2 any service at all.
  const slots = Array.from({length: 16}, (_, i) => i);
  const stations = [
    {id: 'S1', link: 'L', battery: 16, windows: slotWindows('S1', slots)},
    {id: 'S2', link: 'L', battery: 16, windows: slotWindows('S2', slots)},
  ];
  const contracts = [
    {id: 'C1', station: 'S1', min: 16, floor: 0, period: 100, quota: 16},
    {id: 'C2', station: 'S2', min: 1, floor: 1, period: 100, quota: 16},
  ];
  const r = computeSchedule({stations, contracts, fixed: []});
  assert.equal(r.counts.get('C2') || 0, 1, 'floor must be guaranteed under contention');
  assert.equal(r.counts.get('C1') || 0, 15);

  const noFloor = contracts.map((c) => ({...c, floor: 0}));
  const r2 = computeSchedule({stations, contracts: noFloor, fixed: []});
  assert.equal(r2.counts.get('C2') || 0, 0, 'without the floor C2 is starved');
  assert.equal(r2.counts.get('C1') || 0, 16);
});

test('tie-break: deficit desc, then station id, then start', () => {
  // C1 and C2 have equal deficit; S1 < S2 so C1 is served first on the shared link.
  const stations = [
    {id: 'S1', link: 'L', battery: 1, windows: [{id: 'a', start: 0, end: 1, cost: 1}]},
    {id: 'S2', link: 'L', battery: 1, windows: [{id: 'b', start: 0, end: 1, cost: 1}]},
  ];
  const contracts = [
    {id: 'C2', station: 'S2', min: 1, floor: 0, period: 10, quota: 1},
    {id: 'C1', station: 'S1', min: 1, floor: 0, period: 10, quota: 1},
  ];
  const r = computeSchedule({stations, contracts, fixed: []});
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].station, 'S1');
});
