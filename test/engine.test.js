'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { QcEngine } = require('../src/engine');

const CONFIG = { noiseThreshold: 2.0, calibQualityThreshold: 0.5 };

function baseState() {
  return {
    frames: [
      { frameId: 'f1', night: 'N1', instrument: 'camA', metrics: { noise: 1.0 } },
      { frameId: 'f2', night: 'N1', instrument: 'camA', metrics: { noise: 3.0 } },
      { frameId: 'f3', night: 'N1', instrument: 'camB', metrics: { noise: 1.0 } },
      { frameId: 'g1', night: 'N2', instrument: 'camA', metrics: { noise: 1.0 } },
    ],
    calibrations: [
      { kind: 'dark', night: 'N1', instrument: 'camA', version: 1, quality: 0.9 },
      { kind: 'flat', night: 'N1', instrument: 'camA', version: 1, quality: 0.9 },
      { kind: 'dark', night: 'N1', instrument: 'camB', version: 1, quality: 0.9 },
      { kind: 'flat', night: 'N1', instrument: 'camB', version: 1, quality: 0.9 },
      { kind: 'dark', night: 'N2', instrument: 'camA', version: 1, quality: 0.9 },
      { kind: 'flat', night: 'N2', instrument: 'camA', version: 1, quality: 0.9 },
    ],
    weather: [
      { night: 'N1', state: 'clear' },
      { night: 'N2', state: 'clear' },
    ],
  };
}

function makeEngine(state = baseState()) {
  const engine = new QcEngine(CONFIG);
  engine.loadState(state);
  return engine;
}

test('initial load derives flags and summaries', () => {
  const engine = makeEngine();
  const state = engine.getState();
  assert.equal(state.flags['N1|f1'], 'usable');
  assert.equal(state.flags['N1|f2'], 'degraded');
  assert.equal(state.flags['N1|f3'], 'usable');
  assert.equal(state.flags['N2|g1'], 'usable');
  const n1 = state.summaries.find((s) => s.night === 'N1');
  assert.deepEqual({ total: n1.total, usable: n1.usable, degraded: n1.degraded, blocked: n1.blocked }, { total: 3, usable: 2, degraded: 1, blocked: 0 });
  assert.equal(n1.nightFlag, 'degraded');
});

test('weather change invalidates only that night, queue sorted by (night, frameId)', () => {
  const engine = makeEngine();
  const result = engine.applyTransaction({
    id: 't1',
    ops: [{ op: 'setWeather', night: 'N1', state: 'blocked' }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.recomputeQueue, [
    { type: 'frame', night: 'N1', frameId: 'f1' },
    { type: 'frame', night: 'N1', frameId: 'f2' },
    { type: 'frame', night: 'N1', frameId: 'f3' },
    { type: 'summary', night: 'N1' },
  ]);
  assert.deepEqual(
    result.flagDiffs.map((d) => [d.frameId, d.before, d.after]),
    [
      ['f1', 'usable', 'blocked'],
      ['f2', 'degraded', 'blocked'],
      ['f3', 'usable', 'blocked'],
    ],
  );
  assert.equal(engine.getState().flags['N2|g1'], 'usable');
  assert.equal(result.certificate.budget.used, 4);
  assert.match(result.certificate.digest, /^[0-9a-f]{64}$/);
});

test('calibration correction propagates only to dependent frames', () => {
  const engine = makeEngine();
  const result = engine.applyTransaction({
    ops: [{ op: 'upsertCalibration', calibration: { kind: 'dark', night: 'N1', instrument: 'camB', version: 2, quality: 0.1 } }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.recomputeQueue, [
    { type: 'frame', night: 'N1', frameId: 'f3' },
    { type: 'summary', night: 'N1' },
  ]);
  assert.deepEqual(result.flagDiffs, [{ night: 'N1', frameId: 'f3', before: 'usable', after: 'degraded' }]);
});

test('removing a calibration blocks dependent frames', () => {
  const engine = makeEngine();
  const result = engine.applyTransaction({
    ops: [{ op: 'removeCalibration', kind: 'flat', night: 'N2', instrument: 'camA' }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.flagDiffs, [{ night: 'N2', frameId: 'g1', before: 'usable', after: 'blocked' }]);
});

test('budget exceeded returns E_BUDGET and rolls back all state', () => {
  const engine = makeEngine();
  const before = engine.getState();
  const result = engine.applyTransaction({
    id: 'tight',
    budget: 2,
    ops: [{ op: 'setWeather', night: 'N1', state: 'blocked' }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.txnId, 'tight');
  assert.equal(result.error.code, 'E_BUDGET');
  assert.deepEqual(engine.getState(), before);
});

test('budget exactly equal to the recompute count succeeds', () => {
  const engine = makeEngine();
  const result = engine.applyTransaction({
    budget: 4,
    ops: [{ op: 'setWeather', night: 'N1', state: 'blocked' }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.certificate.budget.used, 4);
});

test('regroup only touches the moved frame and affected summaries', () => {
  const engine = makeEngine();
  const result = engine.applyTransaction({
    ops: [{ op: 'regroupFrame', night: 'N1', frameId: 'f1', newNight: 'N2', newInstrument: 'camA' }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.recomputeQueue, [
    { type: 'frame', night: 'N2', frameId: 'f1' },
    { type: 'summary', night: 'N1' },
    { type: 'summary', night: 'N2' },
  ]);
  assert.deepEqual(result.flagDiffs, []);
  const state = engine.getState();
  assert.equal(state.flags['N2|f1'], 'usable');
  assert.equal(state.flags['N1|f1'], undefined);
  assert.equal(state.summaries.find((s) => s.night === 'N1').total, 2);
  assert.equal(state.summaries.find((s) => s.night === 'N2').total, 2);
});

test('regroup across instruments picks up the new group dependencies', () => {
  const engine = makeEngine();
  const result = engine.applyTransaction({
    ops: [
      { op: 'removeCalibration', kind: 'dark', night: 'N1', instrument: 'camB' },
      { op: 'regroupFrame', night: 'N1', frameId: 'f1', newInstrument: 'camB' },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.recomputeQueue.map((n) => [n.type, n.night, n.frameId ?? null]),
    [
      ['frame', 'N1', 'f1'],
      ['frame', 'N1', 'f3'],
      ['summary', 'N1', null],
    ],
  );
  assert.deepEqual(result.flagDiffs, [
    { night: 'N1', frameId: 'f1', before: 'usable', after: 'blocked' },
    { night: 'N1', frameId: 'f3', before: 'usable', after: 'blocked' },
  ]);
});

test('empty night stays stable across transactions', () => {
  const engine = makeEngine({ ...baseState(), nights: ['N3'] });
  const initial = engine.getState().summaries.find((s) => s.night === 'N3');
  assert.deepEqual(initial, { night: 'N3', total: 0, usable: 0, degraded: 0, blocked: 0, nightFlag: 'usable' });
  const result = engine.applyTransaction({ ops: [{ op: 'setWeather', night: 'N3', state: 'blocked' }] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.recomputeQueue, []);
  assert.deepEqual(engine.getState().summaries.find((s) => s.night === 'N3'), initial);
});

test('removing the last frame of a night empties but keeps its summary', () => {
  const engine = makeEngine();
  const result = engine.applyTransaction({
    ops: [{ op: 'removeFrame', night: 'N2', frameId: 'g1' }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.flagDiffs, [{ night: 'N2', frameId: 'g1', before: 'usable', after: null }]);
  assert.deepEqual(engine.getState().summaries.find((s) => s.night === 'N2'), {
    night: 'N2',
    total: 0,
    usable: 0,
    degraded: 0,
    blocked: 0,
    nightFlag: 'usable',
  });
});

test('invalid op rolls back and reports E_INVALID', () => {
  const engine = makeEngine();
  const before = engine.getState();
  const result = engine.applyTransaction({
    ops: [
      { op: 'setWeather', night: 'N1', state: 'blocked' },
      { op: 'setWeather', night: 'N2', state: 'hurricane' },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'E_INVALID');
  assert.deepEqual(engine.getState(), before);
});

test('threshold equality is stable through the engine', () => {
  const engine = makeEngine({
    frames: [{ frameId: 'f1', night: 'N1', instrument: 'camA', metrics: { noise: 2.0 } }],
    calibrations: [
      { kind: 'dark', night: 'N1', instrument: 'camA', version: 1, quality: 0.5 },
      { kind: 'flat', night: 'N1', instrument: 'camA', version: 1, quality: 0.5 },
    ],
    weather: [{ night: 'N1', state: 'clear' }],
  });
  assert.equal(engine.getState().flags['N1|f1'], 'usable');
  const result = engine.applyTransaction({
    ops: [{ op: 'addFrame', frame: { frameId: 'f2', night: 'N1', instrument: 'camA', metrics: { noise: 2.0 } } }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.flagDiffs, [{ night: 'N1', frameId: 'f2', before: null, after: 'usable' }]);
});
