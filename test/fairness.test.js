'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../src/engine');

// big and small share one downlink. big's contract is satisfiable; small's is
// not (min 5 with only 2 windows). Without a floor, max-contract optimization
// gives small nothing; with floor 1 the starved station is guaranteed a slot.
function floorScenario(floor) {
  return {
    name: 'floor-demo',
    floor,
    stations: [
      {
        id: 'big',
        link: 'L',
        battery: 6,
        windows: [0, 2, 4, 6, 8, 10].map((s, i) => ({
          id: `b${i + 1}`,
          start: s,
          end: s + 2,
          energy: 1,
        })),
      },
      {
        id: 'small',
        link: 'L',
        battery: 2,
        windows: [
          { id: 's1', start: 1, end: 3, energy: 1 },
          { id: 's2', start: 5, end: 7, energy: 1 },
        ],
      },
    ],
    contracts: [
      { id: 'Cbig', station: 'big', min: 4 },
      { id: 'Csmall', station: 'small', min: 5 },
    ],
  };
}

test('acceptance 2: starved station receives the floor', () => {
  const { plan } = engine.fold(floorScenario(1), []);
  assert.ok(plan.schedule.small.length >= 1, 'small must get its floor slot');
  assert.ok(plan.schedule.big.length >= 4, 'big contract still satisfied');
  assert.equal(plan.unmet.length, 1);
  assert.equal(plan.unmet[0].contract, 'Csmall');
  assert.equal(plan.unmet[0].reason, 'insufficient-windows');
});

test('floor 0 lets the dominant contract squeeze others out', () => {
  const { plan } = engine.fold(floorScenario(0), []);
  assert.equal(plan.schedule.small.length, 0);
  assert.ok(plan.schedule.big.length >= 4);
});

test('floor also holds on the greedy path (>16 candidates)', () => {
  const scenario = floorScenario(1);
  const filler = [];
  for (let j = 0; j < 20; j++) {
    filler.push({ id: `f${j}`, start: j * 2, end: j * 2 + 1, energy: 1 });
  }
  scenario.stations.push({ id: 'filler', link: 'solo:filler', battery: 20, windows: filler });
  scenario.contracts.push({ id: 'Cfiller', station: 'filler', min: 10 });
  const { plan } = engine.fold(scenario, []);
  assert.ok(plan.schedule.small.length >= 1, 'small must get its floor slot');
  assert.ok(plan.schedule.big.length >= 4, 'big contract still satisfied');
});
