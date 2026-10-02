import test from 'node:test';
import assert from 'node:assert/strict';
import { solveAll } from '../src/solver.js';
import { mulberry32, bruteForceSolve, serializeSolution, BASE } from '../testlib/helpers.js';

// Acceptance 3: for instances with <= 6 carriers, cross-check the solver
// against an independent brute-force enumeration: identical optimal
// objective, identical set of tied optimal solutions, and every reported
// solution respects the hard capacity budget.
test('solver matches brute-force enumeration on randomized instances (<=6 carriers)', () => {
  const rand = mulberry32(20261003);
  const pick = (n) => Math.floor(rand() * n);

  for (let iter = 0; iter < 300; iter += 1) {
    const nCarriers = 1 + pick(6);
    const nWindows = 1 + pick(3);
    const lots = ['L1', 'L2', 'L3'];
    const scores = new Map(lots.map((l) => [l, pick(11)]));

    const carriers = [];
    for (let i = 0; i < nCarriers; i += 1) {
      const eventTs = BASE + pick(10) * 60_000;
      carriers.push({
        carrier: `C${i}`,
        lot: lots[pick(lots.length)],
        qty: 1 + pick(3),
        op: pick(2) === 0 ? 'A' : 'B',
        eventTs,
        due: eventTs + pick(5) * 60_000,
      });
    }
    const windows = [];
    for (let j = 0; j < nWindows; j += 1) {
      const start = BASE + pick(10) * 60_000;
      windows.push({
        tool: `T${j}`,
        cap: pick(6),
        windowStart: start,
        windowEnd: start + (1 + pick(8)) * 60_000,
        op: pick(2) === 0 ? 'A' : 'B',
      });
    }
    const scoreOf = (lot) => scores.get(lot) ?? 0;

    const got = solveAll({ carriers, windows, scoreOf });
    const want = bruteForceSolve(carriers, windows, scoreOf);

    assert.deepEqual(
      got.objective, want.objective,
      `objective mismatch at iter ${iter}: ${JSON.stringify({ carriers, windows })}`,
    );

    const gotSet = new Set(
      got.solutions.map((s) => serializeSolution(s, carriers.map((c) => c.carrier))),
    );
    assert.equal(gotSet.size, got.solutions.length, `duplicate solutions at iter ${iter}`);
    assert.deepEqual(gotSet, want.solutions, `tied-solution set mismatch at iter ${iter}`);

    for (const solution of got.solutions) {
      const used = new Map();
      for (const a of solution.assignments) {
        used.set(a.tool, (used.get(a.tool) ?? 0) + a.qty);
      }
      for (const w of windows) {
        assert.ok(
          (used.get(w.tool) ?? 0) <= w.cap,
          `budget exceeded on ${w.tool} at iter ${iter}`,
        );
      }
    }
  }
});
