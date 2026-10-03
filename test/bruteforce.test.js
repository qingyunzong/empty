'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');
const { certificate } = require('../src/certificate');
const { bruteForce, mulberry32, ts } = require('../test-support/helpers');

const AMOUNTS = [10, 20, 30, 40, 50, 60, 70, 100];

function randomScenario(rng) {
  const events = [];
  const internalCount = 2 + Math.floor(rng() * 4);
  const externalCount = 2 + Math.floor(rng() * 4);
  const externals = [];
  for (let k = 0; k < internalCount; k++) {
    events.push({
      type: 'internal',
      id: `I${k}`,
      amount: AMOUNTS[Math.floor(rng() * AMOUNTS.length)],
      ts: ts(Math.floor(rng() * 48)),
    });
  }
  for (let k = 0; k < externalCount; k++) {
    const id = `E${k}`;
    externals.push(id);
    events.push({
      type: 'external',
      id,
      amount: AMOUNTS[Math.floor(rng() * AMOUNTS.length)],
      ts: ts(Math.floor(rng() * 48)),
    });
  }
  // interleave mutations
  const live = externals.slice();
  for (let k = 0; k < 3; k++) {
    const roll = rng();
    if (roll < 0.35 && live.length > 0) {
      const id = live.splice(Math.floor(rng() * live.length), 1)[0];
      events.push({ type: 'revoke', id });
    } else if (roll < 0.7 && live.length > 0) {
      const id = live[Math.floor(rng() * live.length)];
      events.push({ type: 'correct', id, amount: AMOUNTS[Math.floor(rng() * AMOUNTS.length)] });
    } else {
      events.push({ type: 'rule', version: rng() < 0.5 ? 'v1' : 'v2' });
    }
  }
  return events;
}

test('incremental engine matches brute-force full recompute on random event streams', () => {
  for (let trial = 0; trial < 40; trial++) {
    const rng = mulberry32(trial * 7919 + 1);
    const events = randomScenario(rng);
    const rulesVersion = rng() < 0.5 ? 'v1' : 'v2';
    const engine = new Engine({ rulesVersion });
    for (const event of events) {
      engine.apply(event);
      assert.deepEqual(
        engine.getAllClusters(),
        bruteForce(engine),
        `trial ${trial}: divergence after ${JSON.stringify(event)}`
      );
    }
  }
});

test('recompute is deterministic: same events yield identical certificate', () => {
  const rng = mulberry32(424242);
  const events = randomScenario(rng);
  const a = new Engine({ rulesVersion: 'v2' });
  const b = new Engine({ rulesVersion: 'v2' });
  for (const event of events) {
    a.apply(event);
    b.apply(event);
  }
  assert.equal(certificate(a).sha256, certificate(b).sha256);
  // and a from-scratch rebuild agrees with the incremental result
  const c = new Engine({ rulesVersion: 'v2' });
  for (const event of events) c.apply(event);
  c.recomputeAll();
  assert.equal(certificate(c).sha256, certificate(a).sha256);
});
