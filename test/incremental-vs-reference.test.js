'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Engine } = require('../src/engine');
const { reduceOps, evaluateAll, snapshotFrom, diffStates } = require('../src/reference');
const { mulberry32, randomOp } = require('./helpers');

// Acceptance 1: two plates, <= 8 wells each; after every op (including
// undo/redo) the incremental engine must match a from-scratch full
// enumeration on values, invalid sets and the certificate diff.
test('incremental engine matches full-enumeration reference', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const rng = mulberry32(seed);
    const engine = new Engine();
    engine.apply({ type: 'addPlate', plate: 'A' });
    engine.apply({ type: 'addPlate', plate: 'B' });

    for (let step = 0; step < 120; step++) {
      const histBefore = engine.history();
      const refBefore = snapshotFrom(evaluateAll(reduceOps(histBefore)));

      const op = randomOp(rng, reduceOps(histBefore));
      const cert = engine.apply(op);

      const histAfter = engine.history();
      const refStates = evaluateAll(reduceOps(histAfter));
      const refAfter = snapshotFrom(refStates);

      const snap = engine.snapshot();
      const ctx = `seed=${seed} step=${step} op=${JSON.stringify(op)}`;
      assert.deepStrictEqual(snap.values, refAfter.values, `values differ (${ctx})`);
      assert.deepStrictEqual(snap.invalid, refAfter.invalid, `invalid set differs (${ctx})`);
      assert.deepStrictEqual(snap.errors, refAfter.errors, `error set differs (${ctx})`);

      const expectedChanged = diffStates(evaluateAll(reduceOps(histBefore)), refStates);
      assert.deepStrictEqual(cert.changed, expectedChanged, `certificate diff differs (${ctx})`);
      assert.deepStrictEqual(cert.invalid, refAfter.invalid, `certificate invalid differs (${ctx})`);
      assert.deepStrictEqual(cert.errors, refAfter.errors, `certificate errors differ (${ctx})`);

      // Every changed-and-still-present node must have been recomputed.
      const recomputed = new Set(cert.recomputed);
      for (const [id, st] of Object.entries(cert.changed)) {
        if (st !== null) assert.ok(recomputed.has(id), `changed node not recomputed: ${id} (${ctx})`);
      }
      // Sanity: never recompute more nodes than exist.
      assert.ok(cert.recomputed.length <= Object.keys(snap.values).length, ctx);
    }
  }
});
