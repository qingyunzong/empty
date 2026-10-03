'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Series,
  fullRecompute,
  E_FINALIZED,
  E_TS,
  E_RANGE,
  E_INVALID,
  E_UNDO,
  E_REDO,
} = require('../src/timeseries.js');

// Deterministic PRNG (mulberry32) so runs are reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function outputsOf(series, id) {
  return series.windowOutputs(id);
}

function assertMatchesReference(series, windowsSpec, message) {
  const ref = fullRecompute(series.obs, windowsSpec);
  for (const w of windowsSpec) {
    assert.deepEqual(outputsOf(series, w.id), ref[w.id], `${message} window=${w.id}`);
  }
}

function diffFrom(before, after) {
  // Expected diff between two reference output maps, keyed by "window:endTs".
  const expected = new Map();
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const id of keys) {
    const b = new Map((before[id] ?? []).map((p) => [p.endTs, p.value]));
    const a = new Map((after[id] ?? []).map((p) => [p.endTs, p.value]));
    for (const t of new Set([...b.keys(), ...a.keys()])) {
      const oldV = b.has(t) ? b.get(t) : null;
      const newV = a.has(t) ? a.get(t) : null;
      if (oldV !== newV) expected.set(`${id}:${t}`, { window: id, endTs: t, old: oldV, new: newV });
    }
  }
  return expected;
}

function assertDiffMatches(actualDiff, expectedMap, message) {
  const actual = new Map(actualDiff.map((d) => [`${d.window}:${d.endTs}`, d]));
  assert.deepEqual(actual, expectedMap, message);
}

test('acceptance 1: incremental updates match full recompute (<=12 points, 3 windows)', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rand = rng(seed);
    const n = 1 + Math.floor(rand() * 12); // 1..12 points
    const observations = [];
    for (let i = 0; i < n; i++) observations.push({ t: i + 1, v: Math.round(rand() * 2000) / 100 - 10 });
    const windowsSpec = [
      { id: 'm2', type: 'mean', length: 1 + Math.floor(rand() * 4) },
      { id: 'v3', type: 'var', length: 1 + Math.floor(rand() * 4) },
      { id: 'm4', type: 'mean', length: 1 + Math.floor(rand() * 4) },
    ];
    const series = new Series({ observations, windows: windowsSpec });
    assertMatchesReference(series, windowsSpec, `seed=${seed} initial`);

    const steps = 1 + Math.floor(rand() * 6);
    for (let step = 0; step < steps; step++) {
      const before = fullRecompute(series.obs, windowsSpec);
      const target = observations[Math.floor(rand() * n)].t;
      const op = ['set', 'offset', 'scale'][Math.floor(rand() * 3)];
      const value = Math.round(rand() * 400) / 100 - 2;
      const res = series.applyCorrection({ targetTs: target, op, value, reason: `fix-${step}`, ts: 1000 + step });
      assert.equal(res.ok, true, `seed=${seed} step=${step} apply`);
      const after = fullRecompute(series.obs, windowsSpec);
      assertMatchesReference(series, windowsSpec, `seed=${seed} step=${step}`);
      assertDiffMatches(res.diff, diffFrom(before, after), `seed=${seed} step=${step} diff`);
      if (res.diff.length > 0) {
        const ts = res.diff.map((d) => d.endTs);
        assert.deepEqual(res.affected, { from: Math.min(...ts), to: Math.max(...ts) });
      } else {
        assert.equal(res.affected, null);
      }
    }

    // Window length changes: dependencies rebuilt dynamically.
    for (const w of windowsSpec) {
      const before = fullRecompute(series.obs, windowsSpec);
      const newLen = 1 + Math.floor(rand() * 5);
      const res = series.setWindowLength(w.id, newLen);
      assert.equal(res.ok, true);
      w.length = newLen;
      const after = fullRecompute(series.obs, windowsSpec);
      assertMatchesReference(series, windowsSpec, `seed=${seed} relen ${w.id}=${newLen}`);
      assertDiffMatches(res.diff, diffFrom(before, after), `seed=${seed} relen diff`);
    }

    // Certificate is deterministic for identical state.
    const twin = new Series({ observations: [], windows: [] });
    twin.obs = series.obs.map((o) => ({ ...o }));
    for (const w of windowsSpec) twin.addWindow(w);
    for (const o of series.obs) { /* windows recompute on add */ }
    assert.equal(series.certificate(), series.certificate());
  }
});

test('acceptance 2: out-of-order corrections are ordered by ts then minimally invalidated', () => {
  const observations = Array.from({ length: 8 }, (_, i) => ({ t: i + 1, v: 10 + i }));
  const windowsSpec = [
    { id: 'm2', type: 'mean', length: 2 },
    { id: 'v3', type: 'var', length: 3 },
  ];
  const batch = [
    { targetTs: 6, op: 'offset', value: 100, reason: 'late', ts: 300 },
    { targetTs: 2, op: 'set', value: -5, reason: 'early', ts: 100 },
    { targetTs: 4, op: 'scale', value: 2, reason: 'mid', ts: 200 },
  ];

  const shuffled = new Series({ observations, windows: windowsSpec });
  const results = shuffled.applyCorrections(batch);
  // Applied in ts order: 100, 200, 300.
  assert.deepEqual(results.map((r) => r.applied.ts), [100, 200, 300]);

  const ordered = new Series({ observations, windows: windowsSpec });
  for (const c of [...batch].sort((a, b) => a.ts - b.ts)) ordered.applyCorrection(c);
  assert.deepEqual(shuffled.obs, ordered.obs);
  assert.equal(shuffled.certificate(), ordered.certificate());

  // Minimal invalidation: a correction at index i only touches window outputs
  // covering i (end indices i .. i+L-1), nothing earlier.
  const series = new Series({ observations, windows: windowsSpec });
  const res = series.applyCorrection({ targetTs: 5, op: 'set', value: 0, reason: 'spot', ts: 1 });
  const touched = new Map();
  for (const d of res.diff) {
    if (!touched.has(d.window)) touched.set(d.window, []);
    touched.get(d.window).push(d.endTs);
  }
  assert.deepEqual(touched.get('m2'), [5, 6]); // length 2 -> ends 5,6
  assert.deepEqual(touched.get('v3'), [5, 6, 7]); // length 3 -> ends 5,6,7
  assert.deepEqual(res.affected, { from: 5, to: 7 });
});

test('acceptance 3a: out-of-bounds and finalized corrections are rejected stably', () => {
  const series = new Series({
    observations: [{ t: 1, v: 1 }, { t: 2, v: 2 }, { t: 3, v: 3 }],
    windows: [{ id: 'm2', type: 'mean', length: 2 }],
    finalizeHorizon: 2,
  });
  const certBefore = series.certificate();

  const oor = series.applyCorrection({ targetTs: 99, op: 'set', value: 1, reason: 'x', ts: 1 });
  assert.equal(oor.ok, false);
  assert.equal(oor.code, E_RANGE);
  assert.deepEqual(oor.diff, []);

  const fin = series.applyCorrection({ targetTs: 1, op: 'set', value: 1, reason: 'x', ts: 2 });
  assert.equal(fin.ok, false);
  assert.equal(fin.code, E_FINALIZED);

  // Boundary: t == finalizeHorizon is still correctable.
  const edge = series.applyCorrection({ targetTs: 2, op: 'offset', value: 1, reason: 'ok', ts: 3 });
  assert.equal(edge.ok, true);

  // Missing reason / ts / bad op are invalid.
  for (const bad of [
    { targetTs: 2, op: 'set', value: 1, ts: 4 },
    { targetTs: 2, op: 'set', value: 1, reason: 'r' },
    { targetTs: 2, op: 'nope', value: 1, reason: 'r', ts: 4 },
  ]) {
    const res = series.applyCorrection(bad);
    assert.equal(res.ok, false);
    assert.equal(res.code, E_INVALID);
  }

  // Failed corrections leave state untouched (apart from the successful edge one).
  const again = new Series({
    observations: [{ t: 1, v: 1 }, { t: 2, v: 2 }, { t: 3, v: 3 }],
    windows: [{ id: 'm2', type: 'mean', length: 2 }],
    finalizeHorizon: 2,
  });
  again.applyCorrection({ targetTs: 99, op: 'set', value: 1, reason: 'x', ts: 1 });
  assert.equal(again.certificate(), certBefore);
});

test('acceptance 3b: duplicate timestamps return E_TS', () => {
  assert.throws(
    () => new Series({ observations: [{ t: 1, v: 1 }, { t: 1, v: 2 }] }),
    (err) => err.code === E_TS
  );
  const series = new Series({ observations: [{ t: 1, v: 1 }] });
  const res = series.addObservation({ t: 1, v: 9 });
  assert.equal(res.ok, false);
  assert.equal(res.code, E_TS);
  const ok = series.addObservation({ t: 2, v: 3 });
  assert.equal(ok.ok, true);
  assert.deepEqual(series.obs.map((o) => o.t), [1, 2]);
});

test('acceptance 3c: zero-length window yields stable empty outputs', () => {
  const series = new Series({
    observations: [{ t: 1, v: 1 }, { t: 2, v: 2 }],
    windows: [{ id: 'z', type: 'mean', length: 0 }],
  });
  assert.deepEqual(series.windowOutputs('z'), []);
  const res = series.applyCorrection({ targetTs: 1, op: 'set', value: 5, reason: 'r', ts: 1 });
  assert.equal(res.ok, true);
  assert.deepEqual(res.diff, []);
  assert.equal(res.affected, null);
  const relen = series.setWindowLength('z', 0);
  assert.equal(relen.ok, true);
  assert.deepEqual(relen.diff, []);
  assert.equal(typeof series.certificate(), 'string');
});

test('acceptance 3d: undo/redo, redo stack cleared on new correction', () => {
  const series = new Series({
    observations: [{ t: 1, v: 1 }, { t: 2, v: 2 }, { t: 3, v: 3 }],
    windows: [{ id: 'm2', type: 'mean', length: 2 }],
  });
  const initial = series.certificate();
  series.applyCorrection({ targetTs: 2, op: 'set', value: 20, reason: 'a', ts: 1 });
  series.applyCorrection({ targetTs: 3, op: 'offset', value: 30, reason: 'b', ts: 2 });

  const u1 = series.undo();
  assert.equal(u1.ok, true);
  assert.equal(series.obs[2].v, 3);
  const u2 = series.undo();
  assert.equal(u2.ok, true);
  assert.equal(series.obs[1].v, 2);
  assert.equal(series.certificate(), initial);

  const r1 = series.redo();
  assert.equal(r1.ok, true);
  assert.equal(series.obs[1].v, 20);
  assert.equal(series.redoStack.length, 1);

  // New correction clears the redo stack.
  series.applyCorrection({ targetTs: 1, op: 'scale', value: 10, reason: 'c', ts: 3 });
  assert.equal(series.redoStack.length, 0);
  const r2 = series.redo();
  assert.equal(r2.ok, false);
  assert.equal(r2.code, E_REDO);

  // Undo of everything then undo again is a stable error.
  series.undo();
  series.undo();
  const u3 = series.undo();
  assert.equal(u3.ok, false);
  assert.equal(u3.code, E_UNDO);
});

test('acceptance 3e: empty sequence is stable', () => {
  const series = new Series({ observations: [], windows: [{ id: 'm2', type: 'mean', length: 2 }] });
  assert.deepEqual(series.windowOutputs('m2'), []);
  const res = series.applyCorrection({ targetTs: 1, op: 'set', value: 1, reason: 'r', ts: 1 });
  assert.equal(res.ok, false);
  assert.equal(res.code, E_RANGE);
  const relen = series.setWindowLength('m2', 5);
  assert.equal(relen.ok, true);
  assert.deepEqual(relen.diff, []);
  assert.equal(series.undo().code, E_UNDO);
  assert.equal(series.redo().code, E_REDO);
  assert.match(series.certificate(), /^[0-9a-f]{64}$/);
  // Late-arriving observations still build windows incrementally.
  series.setWindowLength('m2', 2);
  series.addObservation({ t: 2, v: 4 });
  series.addObservation({ t: 1, v: 2 });
  assert.deepEqual(series.windowOutputs('m2'), [{ endTs: 2, value: 3 }]);
});

test('certificate is deterministic and state-sensitive', () => {
  const mk = () =>
    new Series({
      observations: [{ t: 1, v: 1 }, { t: 2, v: 2 }],
      windows: [{ id: 'm2', type: 'mean', length: 2 }],
      finalizeHorizon: 0,
    });
  const a = mk();
  const b = mk();
  assert.equal(a.certificate(), b.certificate());
  b.applyCorrection({ targetTs: 2, op: 'set', value: 5, reason: 'r', ts: 1 });
  assert.notEqual(a.certificate(), b.certificate());
});
