import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveTransitions } from '../src/derive.js';

const CFG = {
  pressureLimit: 1000,
  tempLimit: 180,
  durationMs: 3000,
  windowMs: 1_000_000_000, // effectively last-value-carry-forward
};
const WATERMARK = 6000;
const GRID = [0, 1000, 2000, 3000, 4000, 5000];

// Independent reference: step-function semantics over the sample grid.
function referenceTransitions(samples) {
  const times = [...new Set(samples.map((s) => s.ts))].sort((a, b) => a - b);
  const condAt = (t) => {
    let pressure = null;
    let temperature = null;
    for (const s of samples) {
      if (s.ts > t) continue;
      if (s.tag === 'pressure') {
        if (!pressure || s.ts >= pressure.ts) pressure = s;
      } else if (!temperature || s.ts >= temperature.ts) {
        temperature = s;
      }
    }
    return (
      pressure !== null &&
      temperature !== null &&
      pressure.value > CFG.pressureLimit &&
      temperature.value > CFG.tempLimit
    );
  };
  const out = [];
  let runStart = null;
  for (const t of times) {
    if (condAt(t)) {
      if (runStart === null) runStart = t;
    } else if (runStart !== null) {
      if (t - runStart >= CFG.durationMs) {
        out.push({ ts: runStart + CFG.durationMs, state: 'ARM', since: runStart });
        out.push({ ts: t, state: 'DISARM', since: runStart });
      }
      runStart = null;
    }
  }
  if (runStart !== null && runStart + CFG.durationMs <= WATERMARK) {
    out.push({ ts: runStart + CFG.durationMs, state: 'ARM', since: runStart });
  }
  return out;
}

function canonical(transitions) {
  return transitions.map((t) => JSON.stringify(t)).sort();
}

test('exhaustive 2^6 x 2^6 pressure/temperature sequences match reference', () => {
  const pressureChoices = [900, 1100];
  const tempChoices = [170, 190];
  let cases = 0;
  for (let pMask = 0; pMask < 64; pMask++) {
    for (let tMask = 0; tMask < 64; tMask++) {
      const samples = [];
      for (let i = 0; i < GRID.length; i++) {
        samples.push({
          id: `p${i}`,
          ts: GRID[i],
          tag: 'pressure',
          value: pressureChoices[(pMask >> i) & 1],
          seq: 0,
        });
        samples.push({
          id: `t${i}`,
          ts: GRID[i],
          tag: 'temperature',
          value: tempChoices[(tMask >> i) & 1],
          seq: 0,
        });
      }
      const actual = deriveTransitions(samples, [], CFG, WATERMARK);
      const expected = referenceTransitions(samples);
      assert.deepEqual(
        canonical(actual),
        canonical(expected),
        `mismatch for pMask=${pMask.toString(2)} tMask=${tMask.toString(2)}`,
      );
      cases++;
    }
  }
  assert.equal(cases, 4096);
});

test('trip before ARM is not linked, trip at/after ARM is', () => {
  const samples = [];
  for (const ts of GRID) {
    samples.push({ id: `p${ts}`, ts, tag: 'pressure', value: 1200, seq: 0 });
    samples.push({ id: `t${ts}`, ts, tag: 'temperature', value: 200, seq: 0 });
  }
  const trips = [0, 1000, 2000, 3000, 4000, 5000, 6000].map((ts) => ({
    id: `trip${ts}`,
    ts,
    channel: 'PT-1',
    state: 'TRIPPED',
  }));
  const transitions = deriveTransitions(samples, trips, CFG, WATERMARK);
  const tripTs = transitions
    .filter((t) => t.state === 'TRIP')
    .map((t) => t.ts)
    .sort((a, b) => a - b);
  assert.deepEqual(tripTs, [3000, 4000, 5000, 6000]);
});
