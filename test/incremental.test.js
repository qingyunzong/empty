'use strict';

// Acceptance 1: with at most 2 nights and 5 frames per night, the incremental
// engine must match a full-enumeration QC reference on flags, summaries and
// the recompute queue after every transaction.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');
const { Reference } = require('../src/reference');
const { mulberry32, randomState, randomOp, randomBudget } = require('./helper');

const SCENARIOS = 150;
const OPS_PER_SCENARIO = 14;

test('incremental engine matches full-enumeration reference', () => {
  for (let seed = 1; seed <= SCENARIOS; seed += 1) {
    const rand = mulberry32(seed);
    const config = { threshold: 10 };
    const state = randomState(rand);

    const engine = new Engine(config, state);
    const twin = new Engine(config, state); // determinism check
    const reference = new Reference(config, state);

    assert.deepEqual(engine.getDerived(), reference.derived, `seed ${seed} baseline`);

    let idCounter = 0;
    const nextId = () => seed * 1000 + idCounter++;

    for (let step = 0; step < OPS_PER_SCENARIO; step += 1) {
      const op = randomOp(rand, engine.getState(), nextId);
      const budget = randomBudget(rand);
      const tx = { op, budget };
      const label = `seed ${seed} step ${step} ${JSON.stringify(tx)}`;

      const hashBefore = engine.stateHash();
      const result = engine.applyTransaction(tx);
      const twinResult = twin.applyTransaction(tx);
      assert.deepEqual(result, twinResult, `determinism: ${label}`);

      if (!result.ok) {
        assert.equal(result.error, 'E_BUDGET', label);
        assert.ok(result.required > budget, label);
        // Rolled back: state untouched, reference must not advance.
        assert.equal(engine.stateHash(), hashBefore, `rollback: ${label}`);
        continue;
      }

      const ref = reference.applyTransaction(op);
      assert.ok(ref.ok, label);

      // Flags and summaries match the full-enumeration reference.
      assert.deepEqual(engine.getDerived(), reference.derived, `derived: ${label}`);
      // Flag diffs and recompute queue match the reference change set.
      assert.deepEqual(result.diffs, ref.diffs, `diffs: ${label}`);
      assert.deepEqual(
        result.queue.map((q) => q.node),
        ref.diffs.map((d) => d.node),
        `queue: ${label}`
      );
      // Queue ordering: frames by (night, frameId), then summaries by night.
      const nodes = result.queue;
      const framePart = nodes.filter((n) => n.layer === 'frame');
      const summaryPart = nodes.filter((n) => n.layer === 'summary');
      assert.deepEqual(
        framePart.map((n) => [n.night, n.frameId]),
        [...framePart.map((n) => [n.night, n.frameId])].sort((a, b) =>
          a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1
        ),
        `frame order: ${label}`
      );
      assert.deepEqual(nodes, [...framePart, ...summaryPart], `layer order: ${label}`);
    }
  }
});

test('exhaustive flag enumeration over weather x calibration x signal', () => {
  const { frameFlag } = require('../src/qc');
  const statuses = [undefined, 'clear', 'degraded', 'blocked'];
  const cals = [undefined, {}, { dark: 2 }, { flat: 1 }, { dark: 2, flat: 1 }];
  for (const status of statuses) {
    for (const cal of cals) {
      for (let signal = 0; signal <= 20; signal += 1) {
        const weather = status === undefined ? undefined : { status, attenuation: 1 };
        const flag = frameFlag({ signal }, cal, weather, 10);
        const expected =
          !cal || typeof cal.dark !== 'number' || typeof cal.flat !== 'number' || status === 'blocked'
            ? 'blocked'
            : (signal - 2) * 1 * 1 < 10
              ? 'degraded'
              : 'usable';
        assert.equal(flag, expected, `status=${status} cal=${JSON.stringify(cal)} signal=${signal}`);
      }
    }
  }
});
