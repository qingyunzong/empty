'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Series, ERRORS } = require('../src/series');

const NODE_SPECS = [
  { id: 'm2', type: 'mean', window: 2 },
  { id: 'm3', type: 'mean', window: 3 },
  { id: 'v2', type: 'variance', window: 2 },
];

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
}

function referenceOutputs(obs, specs) {
  const out = {};
  for (const spec of specs) {
    const arr = new Array(obs.length).fill(null);
    for (let i = spec.window - 1; i < obs.length; i++) {
      let sum = 0;
      for (let k = i - spec.window + 1; k <= i; k++) sum += obs[k].value;
      const mean = sum / spec.window;
      if (spec.type === 'mean') {
        arr[i] = mean;
      } else {
        let acc = 0;
        for (let k = i - spec.window + 1; k <= i; k++) {
          const d = obs[k].value - mean;
          acc += d * d;
        }
        arr[i] = acc / spec.window;
      }
    }
    out[spec.id] = arr;
  }
  return out;
}

function outputsOf(series) {
  const out = {};
  for (const node of series.nodes.values()) out[node.id] = node.outputs;
  return out;
}

function assertOutputsMatchReference(series, specs) {
  const ref = referenceOutputs(series.obs, specs);
  const actual = outputsOf(series);
  assert.deepEqual(actual, ref);
}

function minimalRecomputeCount(n, specs, changedIndices) {
  let total = 0;
  for (const spec of specs) {
    const set = new Set();
    for (const i of changedIndices) {
      const from = Math.max(spec.window - 1, i);
      const to = Math.min(n - 1, i + spec.window - 1);
      for (let j = from; j <= to; j++) set.add(j);
    }
    total += set.size;
  }
  return total;
}

function expectedDiffs(before, after) {
  const expected = {};
  for (const id of Object.keys(before)) {
    const changes = [];
    for (let i = 0; i < after[id].length; i++) {
      if (!Object.is(before[id][i], after[id][i])) {
        changes.push({ index: i, old: before[id][i], new: after[id][i] });
      }
    }
    if (changes.length > 0) expected[id] = changes;
  }
  return expected;
}

function actualDiffs(result) {
  const actual = {};
  for (const d of result.diffs) {
    actual[d.node] = d.changes.map((c) => ({ index: c.index, old: c.old, new: c.new }));
  }
  return actual;
}

test('incremental maintenance matches full-enumeration reference (<=12 points, 3 windows)', () => {
  for (let n = 0; n <= 12; n++) {
    const rand = lcg(20261003 + n);
    const series = new Series();
    for (let i = 0; i < n; i++) series.addObservation(i + 1, Math.floor(rand() * 100));
    for (const spec of NODE_SPECS) assert.equal(series.addNode(spec).ok, true);
    assertOutputsMatchReference(series, NODE_SPECS);

    for (let step = 0; step < 10 && n > 0; step++) {
      const targetIdx = Math.floor(rand() * n);
      const ts = targetIdx + 1;
      const op = ['set', 'offset', 'scale'][Math.floor(rand() * 3)];
      const value = Math.floor(rand() * 21) - 10;
      const before = referenceOutputs(series.obs, NODE_SPECS);
      const res = series.applyCorrection({ op, ts, value, reason: 'qc-' + step, cts: step + 1 });
      assert.equal(res.ok, true, `n=${n} step=${step}`);
      const after = referenceOutputs(series.obs, NODE_SPECS);

      assertOutputsMatchReference(series, NODE_SPECS);
      assert.deepEqual(actualDiffs(res), expectedDiffs(before, after), `diff n=${n} step=${step}`);
      assert.equal(res.recomputed, minimalRecomputeCount(n, NODE_SPECS, [targetIdx]), `minimality n=${n} step=${step}`);

      if (res.recomputed > 0) {
        assert.ok(res.affected.startIndex <= res.affected.endIndex);
        for (const d of res.diffs) {
          for (const c of d.changes) {
            assert.ok(c.index >= res.affected.startIndex && c.index <= res.affected.endIndex);
          }
        }
      } else {
        assert.equal(res.affected, null);
      }
      assert.match(res.certificate, /^[0-9a-f]{64}$/);
    }
  }
});

test('out-of-order corrections are reordered by timestamp, then minimally invalidated', () => {
  const build = () => {
    const s = new Series();
    for (let i = 1; i <= 10; i++) s.addObservation(i, i * 10);
    for (const spec of NODE_SPECS) s.addNode(spec);
    return s;
  };

  const corrections = [
    { op: 'offset', ts: 7, value: 5, reason: 'late arrival', cts: 30 },
    { op: 'set', ts: 2, value: 99, reason: 'sensor swap', cts: 10 },
    { op: 'scale', ts: 5, value: 2, reason: 'unit fix', cts: 20 },
  ];

  const batch = build();
  const res = batch.applyCorrections(corrections);
  assert.equal(res.ok, true);
  assert.equal(res.applied, 3);
  assert.deepEqual(batch.log.map((e) => e.cts), [10, 20, 30]);

  const sequential = build();
  for (const c of [...corrections].sort((a, b) => a.cts - b.cts)) sequential.applyCorrection(c);
  assert.deepEqual(outputsOf(batch), outputsOf(sequential));
  assertOutputsMatchReference(batch, NODE_SPECS);

  const changedIndices = [1, 4, 6];
  assert.equal(res.recomputed, minimalRecomputeCount(10, NODE_SPECS, changedIndices));

  const before = referenceOutputs(
    Array.from({ length: 10 }, (_, i) => ({ ts: i + 1, value: (i + 1) * 10 })),
    NODE_SPECS,
  );
  const after = referenceOutputs(batch.obs, NODE_SPECS);
  assert.deepEqual(actualDiffs(res), expectedDiffs(before, after));

  const undone = batch.undo();
  assert.equal(undone.ok, true);
  assertOutputsMatchReference(batch, NODE_SPECS);
  assert.deepEqual(batch.obs.map((o) => o.value), [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
});

test('edge cases: out-of-range, zero window, undo/redo, empty sequence are stable', () => {
  const s = new Series({ finalizeHorizon: 5 });

  const emptyRange = s.applyCorrection({ op: 'set', ts: 1, value: 1, reason: 'x', cts: 1 });
  assert.equal(emptyRange.ok, false);
  assert.equal(emptyRange.error, ERRORS.RANGE);
  assert.deepEqual(s.snapshot().observations, []);
  assert.match(s.certificate(), /^[0-9a-f]{64}$/);
  assert.equal(s.undo().error, ERRORS.UNDO_EMPTY);
  assert.equal(s.redo().error, ERRORS.REDO_EMPTY);

  assert.equal(s.addNode({ id: 'bad', type: 'mean', window: 0 }).error, ERRORS.WINDOW);
  assert.equal(s.addNode({ id: 'neg', type: 'mean', window: -2 }).error, ERRORS.WINDOW);
  assert.equal(s.addNode({ id: 'ok1', type: 'mean', window: 2 }).ok, true);
  assert.equal(s.setWindow('ok1', 0).error, ERRORS.WINDOW);
  assert.equal(s.setWindow('missing', 3).error, ERRORS.NODE);

  for (let i = 1; i <= 8; i++) s.addObservation(i, i);
  assert.equal(s.addObservation(3, 99).error, ERRORS.TS);
  assert.equal(s.addObservation(3.5, Number.NaN).error, ERRORS.INVALID);

  assert.equal(s.applyCorrection({ op: 'set', ts: 3, value: 0, reason: 'frozen', cts: 1 }).error, ERRORS.FINALIZED);
  assert.equal(s.applyCorrection({ op: 'set', ts: 999, value: 0, reason: 'nowhere', cts: 2 }).error, ERRORS.RANGE);
  assert.equal(s.applyCorrection({ op: 'set', ts: 6, value: 0, reason: '', cts: 3 }).error, ERRORS.INVALID);
  assert.equal(s.applyCorrection({ op: 'set', ts: 6, value: 0, reason: 'no cts' }).error, ERRORS.INVALID);
  assert.equal(s.applyCorrection({ op: 'bogus', ts: 6, value: 0, reason: 'x', cts: 4 }).error, ERRORS.INVALID);

  const c1 = s.applyCorrection({ op: 'offset', ts: 6, value: 100, reason: 'first', cts: 5 });
  assert.equal(c1.ok, true);
  assert.equal(s.undo().ok, true);
  const c2 = s.applyCorrection({ op: 'set', ts: 7, value: 42, reason: 'second', cts: 6 });
  assert.equal(c2.ok, true);
  assert.equal(s.redo().error, ERRORS.REDO_EMPTY);
  assert.equal(s.undo().ok, true);
  assert.equal(s.redo().ok, true);
  assert.equal(s.obs[6].value, 42);
});

test('undo/redo restores state and certificates are deterministic', () => {
  const build = () => {
    const s = new Series({ finalizeHorizon: 2 });
    for (let i = 1; i <= 8; i++) s.addObservation(i, i * 3);
    for (const spec of NODE_SPECS) s.addNode(spec);
    return s;
  };

  const a = build();
  const b = build();
  assert.equal(a.certificate(), b.certificate());

  const cert0 = a.certificate();
  a.applyCorrection({ op: 'scale', ts: 5, value: 3, reason: 'calibration', cts: 1 });
  const cert1 = a.certificate();
  assert.notEqual(cert0, cert1);
  a.undo();
  assert.equal(a.certificate(), cert0);
  a.redo();
  assert.equal(a.certificate(), cert1);

  b.applyCorrection({ op: 'scale', ts: 5, value: 3, reason: 'calibration', cts: 1 });
  assert.equal(a.certificate(), b.certificate());

  b.applyCorrection({ op: 'set', ts: 6, value: 1, reason: 'other', cts: 2 });
  assert.notEqual(a.certificate(), b.certificate());
});

test('window length changes rebuild dependencies dynamically', () => {
  const s = new Series();
  for (let i = 1; i <= 6; i++) s.addObservation(i, i * 2);
  s.addNode({ id: 'm', type: 'mean', window: 2 });
  s.addNode({ id: 'v', type: 'variance', window: 2 });

  const specs = [
    { id: 'm', type: 'mean', window: 4 },
    { id: 'v', type: 'variance', window: 2 },
  ];
  const res = s.setWindow('m', 4);
  assert.equal(res.ok, true);
  assertOutputsMatchReference(s, specs);
  assert.deepEqual(actualDiffs(res), expectedDiffs(
    referenceOutputs(s.obs, [
      { id: 'm', type: 'mean', window: 2 },
      { id: 'v', type: 'variance', window: 2 },
    ]),
    referenceOutputs(s.obs, specs),
  ));

  const back = s.setWindow('m', 2);
  assert.equal(back.ok, true);
  assertOutputsMatchReference(s, NODE_SPECS.slice(0, 1).concat([{ id: 'v', type: 'variance', window: 2 }]).map((x) => ({ ...x, id: x.id === 'm2' ? 'm' : x.id, window: 2 })));

  const corr = s.applyCorrection({ op: 'offset', ts: 3, value: 4, reason: 'post-resize', cts: 1 });
  assert.equal(corr.ok, true);
  assertOutputsMatchReference(s, [
    { id: 'm', type: 'mean', window: 2 },
    { id: 'v', type: 'variance', window: 2 },
  ]);
});

test('duplicate observation timestamps are rejected with E_TS', () => {
  const s = new Series();
  assert.equal(s.addObservation(10, 1).ok, true);
  const dup = s.addObservation(10, 2);
  assert.equal(dup.ok, false);
  assert.equal(dup.error, ERRORS.TS);
  assert.equal(s.obs.length, 1);
  assert.equal(s.obs[0].value, 1);
});
