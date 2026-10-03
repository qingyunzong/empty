'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { QcEngine } = require('../src/engine');
const { ReferenceQC } = require('../src/reference');

const CONFIG = { noiseThreshold: 2, calibQualityThreshold: 0.5 };

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, items) {
  return items[Math.floor(rng() * items.length)];
}

function randomState(rng) {
  const nights = ['2026-02-01', '2026-02-02'].slice(0, 1 + Math.floor(rng() * 2));
  const instruments = ['camA', 'camB'].slice(0, 1 + Math.floor(rng() * 2));
  const frames = [];
  for (const night of nights) {
    const count = Math.floor(rng() * 6);
    for (let i = 0; i < count; i += 1) {
      frames.push({
        frameId: `f${i}`,
        night,
        instrument: pick(rng, instruments),
        metrics: { noise: Math.floor(rng() * 5) },
      });
    }
  }
  const calibrations = [];
  for (const night of nights) {
    for (const instrument of instruments) {
      for (const kind of ['dark', 'flat']) {
        if (rng() < 0.7) {
          calibrations.push({
            kind,
            night,
            instrument,
            version: 1,
            quality: pick(rng, [0.3, 0.5, 0.8]),
          });
        }
      }
    }
  }
  const weather = [];
  for (const night of nights) {
    if (rng() < 0.8) weather.push({ night, state: pick(rng, ['clear', 'degraded', 'blocked']) });
  }
  return { frames, calibrations, weather };
}

function randomOps(rng, state, instruments) {
  const ops = [];
  const opCount = 1 + Math.floor(rng() * 3);
  const nights = ['2026-02-01', '2026-02-02'];
  for (let i = 0; i < opCount; i += 1) {
    const kind = pick(rng, ['setWeather', 'upsertCalibration', 'removeCalibration', 'addFrame', 'removeFrame', 'regroupFrame']);
    const night = pick(rng, nights);
    const instrument = pick(rng, instruments);
    if (kind === 'setWeather') {
      ops.push({ op: 'setWeather', night, state: pick(rng, ['clear', 'degraded', 'blocked']) });
    } else if (kind === 'upsertCalibration') {
      ops.push({
        op: 'upsertCalibration',
        calibration: { kind: pick(rng, ['dark', 'flat']), night, instrument, version: 1 + Math.floor(rng() * 3), quality: pick(rng, [0.3, 0.5, 0.8]) },
      });
    } else if (kind === 'removeCalibration') {
      ops.push({ op: 'removeCalibration', kind: pick(rng, ['dark', 'flat']), night, instrument });
    } else if (kind === 'addFrame') {
      ops.push({
        op: 'addFrame',
        frame: { frameId: `x${Math.floor(rng() * 1000)}`, night, instrument, metrics: { noise: Math.floor(rng() * 5) } },
      });
    } else if (state.frames.length > 0) {
      const frame = pick(rng, state.frames);
      if (kind === 'removeFrame') {
        ops.push({ op: 'removeFrame', night: frame.night, frameId: frame.frameId });
      } else {
        ops.push({
          op: 'regroupFrame',
          night: frame.night,
          frameId: frame.frameId,
          newNight: pick(rng, nights),
          newInstrument: pick(rng, instruments),
        });
      }
    }
  }
  return ops;
}

function snapshotOf(engine) {
  return { flags: engine.getState().flags, summaries: engine.getState().summaries };
}

function referenceSnapshot(ref) {
  return {
    flags: Object.fromEntries([...ref.flags.entries()].sort()),
    summaries: [...ref.summaries.values()].sort((a, b) => (a.night < b.night ? -1 : 1)).map((s) => ({ ...s })),
  };
}

test('incremental engine matches full-enumeration reference across random scenarios', () => {
  const SCENARIOS = 300;
  for (let seed = 1; seed <= SCENARIOS; seed += 1) {
    const rng = mulberry32(seed);
    const instruments = ['camA', 'camB'];
    const state = randomState(rng);
    const engine = new QcEngine(CONFIG);
    const reference = new ReferenceQC(CONFIG);
    engine.loadState(state);
    reference.loadState(state);
    assert.deepEqual(snapshotOf(engine), referenceSnapshot(reference), `initial state mismatch (seed ${seed})`);

    const txnCount = 1 + Math.floor(rng() * 4);
    for (let t = 0; t < txnCount; t += 1) {
      const ops = randomOps(rng, state, instruments);
      const budget = rng() < 0.3 ? Math.floor(rng() * 8) : 100;
      const txn = { id: `seed${seed}-txn${t}`, budget, ops };
      const before = snapshotOf(engine);
      const actual = engine.applyTransaction(txn);
      const expected = reference.applyTransaction(txn);
      assert.equal(actual.ok, expected.ok, `ok mismatch (seed ${seed}, txn ${t})`);
      if (!actual.ok) {
        assert.equal(actual.error.code, expected.error.code, `error code mismatch (seed ${seed}, txn ${t})`);
        assert.deepEqual(snapshotOf(engine), before, `rollback mismatch (seed ${seed}, txn ${t})`);
        continue;
      }
      assert.deepEqual(actual.recomputeQueue, expected.recomputeQueue, `queue mismatch (seed ${seed}, txn ${t})`);
      assert.deepEqual(actual.flagDiffs, expected.flagDiffs, `flag diff mismatch (seed ${seed}, txn ${t})`);
      assert.deepEqual(snapshotOf(engine), referenceSnapshot(reference), `state mismatch (seed ${seed}, txn ${t})`);
    }
  }
});

test('regroup scenarios only recompute moved frames and summaries', () => {
  for (let seed = 1000; seed < 1050; seed += 1) {
    const rng = mulberry32(seed);
    const instruments = ['camA', 'camB'];
    const state = randomState(rng);
    if (state.frames.length === 0) continue;
    const engine = new QcEngine(CONFIG);
    engine.loadState(state);
    const frame = pick(rng, state.frames);
    const newNight = pick(rng, ['2026-02-01', '2026-02-02']);
    const occupied = new Set(state.frames.map((f) => `${f.night}|${f.frameId}`));
    const result = engine.applyTransaction({
      budget: 100,
      ops: [{
        op: 'regroupFrame',
        night: frame.night,
        frameId: frame.frameId,
        newNight,
        newInstrument: pick(rng, instruments),
      }],
    });
    if (occupied.has(`${newNight}|${frame.frameId}`) && newNight !== frame.night) {
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'E_INVALID');
      continue;
    }
    assert.equal(result.ok, true);
    const frames = result.recomputeQueue.filter((n) => n.type === 'frame');
    const summaries = result.recomputeQueue.filter((n) => n.type === 'summary');
    assert.ok(frames.length <= 1, 'at most the moved frame is recomputed');
    if (frames.length === 1) assert.equal(frames[0].frameId, frame.frameId);
    assert.ok(summaries.length <= 2, 'at most the source and target night summaries are recomputed');
    for (const diff of result.flagDiffs) assert.equal(diff.frameId, frame.frameId);
  }
});
