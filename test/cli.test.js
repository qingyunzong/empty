'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runCli } = require('../cli.js');

test('cli: corrections from JSON, out-of-order sorted by ts', () => {
  const res = runCli({
    observations: [{ t: 1, v: 1 }, { t: 2, v: 2 }, { t: 3, v: 4 }, { t: 4, v: 8 }],
    windows: [{ id: 'm2', type: 'mean', length: 2 }, { id: 'v3', type: 'var', length: 3 }],
    finalizeHorizon: 1,
    corrections: [
      { targetTs: 3, op: 'offset', value: 2, reason: 'drift', ts: 200 },
      { targetTs: 2, op: 'set', value: 5, reason: 'swap', ts: 100 },
    ],
  });
  assert.equal(res.ok, true);
  const applied = res.results[0].results;
  assert.deepEqual(applied.map((r) => r.applied.ts), [100, 200]);
  assert.deepEqual(res.final.observations.map((o) => o.v), [1, 5, 6, 8]);
  assert.match(res.certificate, /^[0-9a-f]{64}$/);
  for (const r of applied) {
    assert.ok(Array.isArray(r.diff));
    assert.match(r.certificate, /^[0-9a-f]{64}$/);
  }
});

test('cli: operations sequence with undo/redo/setWindowLength', () => {
  const res = runCli({
    observations: [{ t: 1, v: 2 }, { t: 2, v: 4 }, { t: 3, v: 6 }],
    windows: [{ id: 'm2', type: 'mean', length: 2 }],
    operations: [
      { type: 'correct', correction: { targetTs: 2, op: 'set', value: 10, reason: 'r', ts: 1 } },
      { type: 'undo' },
      { type: 'redo' },
      { type: 'setWindowLength', id: 'm2', length: 3 },
    ],
  });
  assert.equal(res.ok, true);
  assert.equal(res.results[1].result.ok, true);
  assert.equal(res.results[2].result.ok, true);
  const m2 = res.final.windows.find((w) => w.id === 'm2');
  assert.equal(m2.length, 3);
  assert.deepEqual(m2.outputs, [{ endTs: 3, value: 6 }]);
});

test('cli: duplicate observation timestamps surface E_TS', () => {
  const res = runCli({ observations: [{ t: 1, v: 1 }, { t: 1, v: 2 }] });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'E_TS');
});

test('cli: empty input is stable', () => {
  const empty = runCli({});
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.final.observations, []);
  assert.match(empty.certificate, /^[0-9a-f]{64}$/);
});

test('cli: deterministic certificate across runs', () => {
  const input = {
    observations: [{ t: 1, v: 1 }, { t: 2, v: 2 }],
    windows: [{ id: 'm2', type: 'mean', length: 2 }],
    corrections: [{ targetTs: 2, op: 'scale', value: 3, reason: 'r', ts: 7 }],
  };
  assert.equal(runCli(input).certificate, runCli(input).certificate);
});
