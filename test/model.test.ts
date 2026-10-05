import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseProblem,
  applyAction,
  holds,
  initialState,
  MutexError,
  ProblemError,
  Problem,
  State,
} from "../src/model.js";

test("parse rejects numBits > 12", () => {
  assert.throws(
    () => parseProblem({ numBits: 13, goal: {}, actions: [{ name: "a", effects: [{ set: { "0": 1 } }] }] }),
    /numBits must be an integer in 1\.\.12/,
  );
});

test("parse rejects out-of-range bit index", () => {
  assert.throws(
    () =>
      parseProblem({
        numBits: 2,
        goal: { bits: { "5": 1 } },
        actions: [{ name: "a", effects: [{ set: { "0": 1 } }] }],
      }),
    /out of range/,
  );
});

test("parse rejects duplicate action names", () => {
  assert.throws(
    () =>
      parseProblem({
        numBits: 1,
        goal: {},
        actions: [
          { name: "a", effects: [{ set: { "0": 1 } }] },
          { name: "a", effects: [{ set: { "0": 0 } }] },
        ],
      }),
    /duplicate action name/,
  );
});

test("parse rejects statically mutex effects", () => {
  assert.throws(
    () =>
      parseProblem({
        numBits: 1,
        goal: {},
        actions: [{ name: "bad", effects: [{ set: { "0": 1 } }, { set: { "0": 0 } }] }],
      }),
    /mutex rejected/,
  );
});

test("parse rejects potentially simultaneous conditional mutex", () => {
  assert.throws(
    () =>
      parseProblem({
        numBits: 2,
        goal: {},
        actions: [
          {
            name: "bad",
            effects: [
              { when: { bits: { "1": 1 } }, set: { "0": 1 } },
              { when: { bits: { "1": 1 } }, set: { "0": 0 } },
            ],
          },
        ],
      }),
    /mutex rejected/,
  );
});

test("contradictory conditions make conflicting effects acceptable", () => {
  const p = parseProblem({
    numBits: 2,
    goal: {},
    actions: [
      {
        name: "ok",
        effects: [
          { when: { bits: { "1": 1 } }, set: { "0": 1 } },
          { when: { bits: { "1": 0 } }, set: { "0": 0 } },
        ],
      },
    ],
  });
  assert.equal(p.actions.length, 1);
});

test("simultaneous effects are evaluated on the OLD state", () => {
  const p = parseProblem({
    numBits: 2,
    goal: {},
    actions: [
      {
        name: "chain",
        effects: [
          { when: { bits: { "0": 1 } }, set: { "1": 1 } },
          { when: { bits: { "1": 1 } }, set: { "0": 0 } },
        ],
      },
    ],
  });
  const s: State = { bits: 0b01, res: [] }; // b0=1, b1=0
  const next = applyAction(p, s, p.actions[0]!);
  assert.ok(next);
  // Old-state semantics: only the first effect fires. If effects were
  // chained on the new state, b0 would have been cleared.
  assert.equal(next.bits, 0b11);
});

test("dynamic mutex conflict is rejected at apply time", () => {
  // Built directly (bypassing parse-time static rejection) to exercise the
  // dynamic guard.
  const p: Problem = {
    name: "dyn",
    numBits: 2,
    resources: [],
    initialBits: 0,
    goal: {},
    actions: [
      {
        name: "boom",
        effects: [
          { when: { bits: { "1": 1 } }, set: { "0": 1 } },
          { when: { bits: { "1": 1 } }, set: { "0": 0 } },
        ],
      },
    ],
  };
  const s: State = { bits: 0b10, res: [] };
  assert.throws(() => applyAction(p, s, p.actions[0]!), MutexError);
  // When the condition does not hold, no conflict arises.
  const quiet = applyAction(p, { bits: 0b00, res: [] }, p.actions[0]!);
  assert.ok(quiet);
  assert.equal(quiet.bits, 0b00);
});

test("finite resources: bounds, consumption, preconditions", () => {
  const p = parseProblem({
    numBits: 1,
    resources: [{ name: "fuel", max: 3, initial: 1 }],
    goal: {},
    actions: [
      {
        name: "burn",
        pre: { resources: [{ index: 0, op: ">=", value: 1 }] },
        effects: [{ res: [{ index: 0, delta: -1 }] }],
      },
      {
        name: "overfill",
        effects: [{ res: [{ index: 0, delta: 5 }] }],
      },
    ],
  });
  const s = initialState(p);
  assert.deepEqual(s.res, [1]);

  const burned = applyAction(p, s, p.actions[0]!);
  assert.ok(burned);
  assert.deepEqual(burned.res, [0]);

  // Cannot burn twice: precondition fails.
  assert.equal(applyAction(p, burned, p.actions[0]!), null);
  // Overfilling beyond max is inapplicable, not an error.
  assert.equal(applyAction(p, s, p.actions[1]!), null);
});

test("resource deltas from simultaneous effects sum on the old state", () => {
  const p = parseProblem({
    numBits: 1,
    resources: [{ name: "r", max: 10, initial: 5 }],
    goal: {},
    actions: [
      {
        name: "mix",
        effects: [
          { when: { resources: [{ index: 0, op: ">=", value: 5 }] }, res: [{ index: 0, delta: 2 }] },
          { when: { resources: [{ index: 0, op: ">=", value: 6 }] }, res: [{ index: 0, delta: 2 }] },
        ],
      },
    ],
  });
  const next = applyAction(p, initialState(p), p.actions[0]!);
  assert.ok(next);
  // Only the first effect fires (old value 5 >= 5, but not >= 6).
  assert.deepEqual(next.res, [7]);
});

test("holds evaluates bit and resource conditions", () => {
  const s: State = { bits: 0b101, res: [3] };
  assert.equal(holds({ bits: { "0": 1, "1": 0, "2": 1 } }, s), true);
  assert.equal(holds({ bits: { "1": 1 } }, s), false);
  assert.equal(holds({ resources: [{ index: 0, op: ">", value: 2 }] }, s), true);
  assert.equal(holds({ resources: [{ index: 0, op: "!=", value: 3 }] }, s), false);
});

test("ProblemError is raised for malformed problems", () => {
  assert.throws(() => parseProblem(null), ProblemError);
  assert.throws(() => parseProblem({ numBits: 0, goal: {}, actions: [{}] }), ProblemError);
});
