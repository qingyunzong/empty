import test from 'node:test';
import assert from 'node:assert/strict';
import { CalibrationChain } from '../src/chain.js';
import { computeReference } from '../src/reference.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const IDS = ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7'];
const COEFF_VALUES = [-4, -1.5, -1, -0.5, 0, 0.5, 1, 2, 3.5, 8];

function pick(rand, arr) {
  return arr[Math.floor(rand() * arr.length)];
}

function randomCoeffs(rand) {
  return {
    raw: pick(rand, COEFF_VALUES),
    offset: pick(rand, COEFF_VALUES),
    scale: pick(rand, COEFF_VALUES),
  };
}

function compareAgainstReference(chain, context) {
  const state = chain.getState();
  const reference = computeReference(state);
  const snapshot = chain.snapshot();
  assert.equal(snapshot.version, state.version, `${context}: version`);
  for (const [id, expected] of Object.entries(reference.results)) {
    const actual = snapshot.results[id];
    assert.ok(actual, `${context}: missing result for ${id}`);
    assert.equal(actual.id, expected.id, `${context}: id ${id}`);
    assert.equal(actual.value, expected.value, `${context}: value of ${id}`);
    assert.equal(actual.blocked, expected.blocked, `${context}: blocked of ${id}`);
    assert.equal(actual.confidence, expected.confidence, `${context}: confidence of ${id}`);
  }
  const actualBlocked = Object.values(snapshot.results).filter((r) => r.blocked).map((r) => r.id).sort();
  const expectedBlocked = Object.values(reference.results).filter((r) => r.blocked).map((r) => r.id).sort();
  assert.deepEqual(actualBlocked, expectedBlocked, `${context}: blocked set`);
  assert.deepEqual(snapshot.certificate, reference.certificate, `${context}: certificate`);
}

test('incremental chain matches full-enumeration reference (<=8 sensors)', () => {
  const SEEDS = 40;
  const STEPS = 120;
  for (let seed = 0; seed < SEEDS; seed++) {
    const rand = mulberry32(seed);
    const chain = new CalibrationChain();
    for (let step = 0; step < STEPS; step++) {
      const state = chain.getState();
      const present = IDS.filter((id) => state.sensors[id]);
      const absent = IDS.filter((id) => !state.sensors[id]);
      const action = Math.floor(rand() * 8);
      switch (action) {
        case 0: {
          if (absent.length > 0) {
            chain.addSensor(pick(rand, absent), randomCoeffs(rand));
          }
          break;
        }
        case 1: {
          if (present.length > 0) chain.removeSensor(pick(rand, present));
          break;
        }
        case 2: {
          if (present.length > 0) {
            chain.setCoefficients(pick(rand, present), randomCoeffs(rand));
          }
          break;
        }
        case 3: {
          const candidates = present.filter((id) => !(id in state.bases));
          if (candidates.length > 0) {
            const id = pick(rand, candidates);
            // Bases may point at existing or missing sensors.
            const basePool = rand() < 0.8 ? present : IDS;
            chain.addCalibration(id, pick(rand, basePool));
          }
          break;
        }
        case 4: {
          const withBase = present.filter((id) => id in state.bases);
          if (withBase.length > 0) chain.removeCalibration(pick(rand, withBase));
          break;
        }
        case 5: {
          // Occasionally probe invalid operations: duplicate base, cycles.
          if (present.length >= 2) {
            const id = pick(rand, present);
            const base = pick(rand, present);
            chain.addCalibration(id, base);
          }
          break;
        }
        case 6: {
          if (rand() < 0.7) chain.undo();
          break;
        }
        case 7: {
          if (rand() < 0.7) chain.redo();
          break;
        }
        default:
          break;
      }
      compareAgainstReference(chain, `seed=${seed} step=${step}`);
    }
  }
});

test('reference itself is deterministic for identical states', () => {
  const state = {
    sensors: {
      a: { raw: 1, offset: 2, scale: 3 },
      b: { raw: 4, offset: 5, scale: 6 },
      c: { raw: 7, offset: 8, scale: 9 },
    },
    bases: { b: 'a', c: 'b' },
  };
  assert.deepEqual(computeReference(state), computeReference(state));
});
