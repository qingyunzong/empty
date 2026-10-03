'use strict';

// Acceptance 3: missing calibration, insufficient budget, empty nights and
// threshold equality are all handled stably.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');

test('missing calibration blocks frames; correction unblocks them', () => {
  const engine = new Engine({ threshold: 10 }, {
    frames: [
      { id: 'f1', night: 'N1', instrument: 'camA', signal: 20 },
      { id: 'f2', night: 'N1', instrument: 'camB', signal: 20 },
    ],
    calibrations: { camA: { dark: 0, flat: 1 } }, // camB missing
  });
  assert.equal(engine.getFlags().f1, 'usable');
  assert.equal(engine.getFlags().f2, 'blocked');

  // Partial calibration (flat missing) is still missing.
  let res = engine.applyTransaction({ op: { type: 'setCalibration', instrument: 'camB', dark: 0 }, budget: 100 });
  assert.ok(res.ok);
  assert.equal(engine.getFlags().f2, 'blocked');

  res = engine.applyTransaction({ op: { type: 'setCalibration', instrument: 'camB', flat: 1 }, budget: 100 });
  assert.ok(res.ok);
  assert.equal(engine.getFlags().f2, 'usable');

  // Removing a calibration blocks dependent frames across nights.
  engine.applyTransaction({ op: { type: 'addFrame', frame: { id: 'f3', night: 'N2', instrument: 'camA', signal: 20 } }, budget: 100 });
  res = engine.applyTransaction({ op: { type: 'removeCalibration', instrument: 'camA' }, budget: 100 });
  assert.ok(res.ok);
  assert.equal(engine.getFlags().f1, 'blocked');
  assert.equal(engine.getFlags().f3, 'blocked');
  assert.equal(engine.getFlags().f2, 'usable');
});

test('weather blocked blocks frames regardless of score', () => {
  const engine = new Engine({ threshold: 10 }, {
    frames: [{ id: 'f1', night: 'N1', instrument: 'camA', signal: 1000 }],
    calibrations: { camA: { dark: 0, flat: 1 } },
    weather: { N1: { status: 'blocked', attenuation: 1 } },
  });
  assert.equal(engine.getFlags().f1, 'blocked');
});

test('budget exceeded returns E_BUDGET and rolls back; exact budget succeeds', () => {
  const engine = new Engine({ threshold: 10 }, {
    frames: [{ id: 'f1', night: 'N1', instrument: 'camA', signal: 20 }],
    calibrations: { camA: { dark: 0, flat: 1 } },
  });
  const hashBefore = engine.stateHash();
  const derivedBefore = engine.getDerived();

  // addFrame recomputes 1 frame + 1 summary = 2 units.
  const tx = { op: { type: 'addFrame', frame: { id: 'f2', night: 'N1', instrument: 'camA', signal: 20 } }, budget: 1 };
  const res = engine.applyTransaction(tx);
  assert.deepEqual({ ok: res.ok, error: res.error, required: res.required, budget: res.budget },
    { ok: false, error: 'E_BUDGET', required: 2, budget: 1 });
  assert.equal(engine.stateHash(), hashBefore);
  assert.deepEqual(engine.getDerived(), derivedBefore);

  // Exact boundary: budget == required succeeds.
  const ok = engine.applyTransaction({ ...tx, budget: 2 });
  assert.ok(ok.ok);
  assert.equal(engine.getFlags().f2, 'usable');

  // Weather change over 2 frames + 1 summary = 3 units.
  const blocked = engine.applyTransaction({ op: { type: 'setWeather', night: 'N1', status: 'blocked' }, budget: 2 });
  assert.equal(blocked.error, 'E_BUDGET');
  assert.equal(blocked.required, 3);
  const okBlocked = engine.applyTransaction({ op: { type: 'setWeather', night: 'N1', status: 'blocked' }, budget: 3 });
  assert.ok(okBlocked.ok);
  assert.equal(engine.getFlags().f1, 'blocked');
});

test('empty nights are stable: no-op weather, summary removal on last frame', () => {
  const engine = new Engine({ threshold: 10 }, {
    frames: [{ id: 'f1', night: 'N1', instrument: 'camA', signal: 20 }],
    calibrations: { camA: { dark: 0, flat: 1 } },
  });
  // Weather on a night with no frames: nothing to recompute, empty queue.
  const res = engine.applyTransaction({ op: { type: 'setWeather', night: 'N-empty', status: 'blocked' }, budget: 0 });
  assert.ok(res.ok);
  assert.deepEqual(res.diffs, []);
  assert.deepEqual(res.queue, []);

  // Removing the last frame of a night removes its summary.
  const rem = engine.applyTransaction({ op: { type: 'removeFrame', frameId: 'f1' }, budget: 10 });
  assert.ok(rem.ok);
  assert.deepEqual(rem.queue.map((q) => q.node), ['frame:f1', 'summary:N1']);
  const summaryDiff = rem.diffs.find((d) => d.node === 'summary:N1');
  assert.equal(summaryDiff.to, null);
  assert.deepEqual(engine.getSummaries(), {});
  assert.deepEqual(engine.getFlags(), {});
});

test('threshold equality is exactly usable, strictly below is degraded', () => {
  const engine = new Engine({ threshold: 10 }, {
    frames: [
      { id: 'eq', night: 'N1', instrument: 'camA', signal: 15 }, // (15-5)*1*1 = 10
      { id: 'below', night: 'N1', instrument: 'camA', signal: 14 }, // 9
      { id: 'eqFloat', night: 'N1', instrument: 'camB', signal: 10.5 }, // (10.5-0.5)*1 = 10
      { id: 'belowFloat', night: 'N1', instrument: 'camB', signal: 10.4 }, // 9.9
      { id: 'eqAtt', night: 'N2', instrument: 'camA', signal: 10 }, // (10-5)*1*2 = 10
    ],
    calibrations: { camA: { dark: 5, flat: 1 }, camB: { dark: 0.5, flat: 1 } },
    weather: { N2: { status: 'clear', attenuation: 2 } },
  });
  const flags = engine.getFlags();
  assert.equal(flags.eq, 'usable');
  assert.equal(flags.below, 'degraded');
  assert.equal(flags.eqFloat, 'usable');
  assert.equal(flags.belowFloat, 'degraded');
  assert.equal(flags.eqAtt, 'usable');
});

test('invalid ops return E_INVALID without mutating state', () => {
  const engine = new Engine({ threshold: 10 }, {
    frames: [{ id: 'f1', night: 'N1', instrument: 'camA', signal: 20 }],
    calibrations: { camA: { dark: 0, flat: 1 } },
  });
  const hash = engine.stateHash();
  for (const op of [
    { type: 'removeFrame', frameId: 'ghost' },
    { type: 'regroup', frameId: 'ghost', night: 'N2' },
    { type: 'removeCalibration', instrument: 'camZ' },
    { type: 'setWeather', night: 'N1', status: 'hurricane' },
    { type: 'addFrame', frame: { id: 'f1', night: 'N1', instrument: 'camA', signal: 1 } },
    { type: 'nuke' },
  ]) {
    const res = engine.applyTransaction({ op, budget: 100 });
    assert.equal(res.error, 'E_INVALID', JSON.stringify(op));
  }
  assert.equal(engine.stateHash(), hash);
});
