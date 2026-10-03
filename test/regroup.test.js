'use strict';

// Acceptance 2: regrouping a frame only affects the moved frame itself and
// the summaries of the source and target nights.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');
const { Reference } = require('../src/reference');

function baseState() {
  return {
    frames: [
      { id: 'a1', night: 'N1', instrument: 'camA', signal: 20 },
      { id: 'a2', night: 'N1', instrument: 'camA', signal: 8 },
      { id: 'b1', night: 'N2', instrument: 'camB', signal: 20 },
      { id: 'b2', night: 'N2', instrument: 'camB', signal: 3 },
    ],
    calibrations: { camA: { dark: 0, flat: 1 }, camB: { dark: 0, flat: 1 } },
    weather: { N1: { status: 'clear', attenuation: 1 }, N2: { status: 'clear', attenuation: 1 } },
  };
}

function setup() {
  return new Engine({ threshold: 10 }, baseState());
}

test('regroup across nights touches only moved frame and both summaries', () => {
  const engine = setup();
  const before = engine.getDerived();
  const res = engine.applyTransaction({ op: { type: 'regroup', frameId: 'a2', night: 'N2' }, budget: 100 });
  assert.ok(res.ok);

  const allowed = new Set(['frame:a2', 'summary:N1', 'summary:N2']);
  for (const entry of res.queue) assert.ok(allowed.has(entry.node), `unexpected node ${entry.node}`);

  const after = engine.getDerived();
  // Untouched frames keep their flags.
  assert.equal(after.flags.a1, before.flags.a1);
  assert.equal(after.flags.b1, before.flags.b1);
  assert.equal(after.flags.b2, before.flags.b2);
  // Summaries recomputed for both nights only.
  assert.deepEqual(after.summaries.N1, { night: 'N1', total: 1, usable: 1, degraded: 0, blocked: 0, status: 'usable' });
  assert.deepEqual(after.summaries.N2, { night: 'N2', total: 3, usable: 1, degraded: 2, blocked: 0, status: 'degraded' });

  const reference = new Reference({ threshold: 10 }, baseState());
  const ref = reference.applyTransaction({ type: 'regroup', frameId: 'a2', night: 'N2' });
  assert.deepEqual(res.diffs, ref.diffs);
  assert.deepEqual(after, reference.derived);
});

test('regroup across instruments within a night touches only that frame and its summary', () => {
  const engine = setup();
  engine.applyTransaction({ op: { type: 'setCalibration', instrument: 'camB', dark: 15, flat: 1 }, budget: 100 });
  const before = engine.getDerived();
  const res = engine.applyTransaction({ op: { type: 'regroup', frameId: 'a1', instrument: 'camB' }, budget: 100 });
  assert.ok(res.ok);

  const allowed = new Set(['frame:a1', 'summary:N1']);
  for (const entry of res.queue) assert.ok(allowed.has(entry.node), `unexpected node ${entry.node}`);

  const after = engine.getDerived();
  assert.equal(after.flags.a1, 'degraded'); // (20 - 15) * 1 = 5 < 10
  assert.equal(after.flags.a2, before.flags.a2);
  assert.equal(after.flags.b1, before.flags.b1);
  assert.equal(after.flags.b2, before.flags.b2);
  assert.deepEqual(after.summaries.N2, before.summaries.N2);
});

test('regroup to a new night creates its summary, empties handled nights', () => {
  const engine = new Engine({ threshold: 10 }, {
    frames: [{ id: 'solo', night: 'N1', instrument: 'camA', signal: 20 }],
    calibrations: { camA: { dark: 0, flat: 1 } },
  });
  const res = engine.applyTransaction({ op: { type: 'regroup', frameId: 'solo', night: 'N3' }, budget: 100 });
  assert.ok(res.ok);
  // The moved frame keeps its flag (same instrument, no weather), so only the
  // two summaries appear in the change set.
  const nodes = res.queue.map((q) => q.node).sort();
  assert.deepEqual(nodes, ['summary:N1', 'summary:N3']);
  const after = engine.getDerived();
  assert.equal(after.summaries.N1, undefined); // empty night: summary removed
  assert.deepEqual(after.summaries.N3, { night: 'N3', total: 1, usable: 1, degraded: 0, blocked: 0, status: 'usable' });
});

test('regroup into a blocked night changes the moved frame flag', () => {
  const engine = new Engine({ threshold: 10 }, {
    frames: [
      { id: 'solo', night: 'N1', instrument: 'camA', signal: 20 },
      { id: 'other', night: 'N1', instrument: 'camA', signal: 20 },
    ],
    calibrations: { camA: { dark: 0, flat: 1 } },
    weather: { N2: { status: 'blocked', attenuation: 1 } },
  });
  const res = engine.applyTransaction({ op: { type: 'regroup', frameId: 'solo', night: 'N2' }, budget: 100 });
  assert.ok(res.ok);
  const nodes = res.queue.map((q) => q.node).sort();
  assert.deepEqual(nodes, ['frame:solo', 'summary:N1', 'summary:N2']);
  assert.equal(engine.getFlags().solo, 'blocked');
  assert.equal(engine.getFlags().other, 'usable');
});
