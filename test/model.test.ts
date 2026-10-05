import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAction,
  initialState,
  isGoal,
  normalizeProblem,
  ProblemError,
} from "../src/model.js";

test("validation: bits range", () => {
  assert.throws(() => normalizeProblem({ bits: 0, initial: 0, goal: {}, actions: [{ name: "a" }] }), ProblemError);
  assert.throws(() => normalizeProblem({ bits: 13, initial: 0, goal: {}, actions: [{ name: "a" }] }), ProblemError);
  assert.throws(() => normalizeProblem({ bits: 12, initial: 1 << 12, goal: {}, actions: [{ name: "a" }] }), ProblemError);
});

test("validation: static mutex unconditional effects rejected", () => {
  assert.throws(
    () => normalizeProblem({ bits: 2, initial: 0, goal: {}, actions: [{ name: "bad", setMask: 1, clearMask: 1 }] }),
    /set and clear the same bit/
  );
});

test("validation: goal cannot require and forbid the same bit", () => {
  assert.throws(
    () => normalizeProblem({ bits: 2, initial: 0, goal: { requireMask: 1, forbidMask: 1 }, actions: [{ name: "a" }] }),
    ProblemError
  );
});

test("preconditions: require and forbid masks", () => {
  const p = normalizeProblem({
    bits: 2,
    initial: 1,
    goal: {},
    actions: [
      { name: "needs-0", requireMask: 1, setMask: 2 },
      { name: "needs-not-0", forbidMask: 1, setMask: 2 },
    ],
  });
  const s = initialState(p);
  assert.ok(applyAction(p, s, p.actions[0]!));
  assert.equal(applyAction(p, s, p.actions[1]!), null);
});

test("conditional effects evaluate on the OLD state (simultaneous swap)", () => {
  const p = normalizeProblem({
    bits: 2,
    initial: 1,
    goal: {},
    actions: [
      {
        name: "swap",
        cond: [
          { requireMask: 1, setMask: 2, clearMask: 1 },
          { requireMask: 2, setMask: 1, clearMask: 2 },
        ],
      },
    ],
  });
  const a = p.actions[0]!;
  // 01 -> 10
  assert.deepEqual(applyAction(p, { bits: 1, res: [] }, a), { bits: 2, res: [] });
  // 10 -> 01
  assert.deepEqual(applyAction(p, { bits: 2, res: [] }, a), { bits: 1, res: [] });
  // 00 -> 00 (no trigger)
  assert.deepEqual(applyAction(p, { bits: 0, res: [] }, a), { bits: 0, res: [] });
});

test("mutex: simultaneously triggered effects that set and clear one bit reject the action", () => {
  const p = normalizeProblem({
    bits: 2,
    initial: 3,
    goal: {},
    actions: [
      {
        name: "swap",
        cond: [
          { requireMask: 1, setMask: 2, clearMask: 1 },
          { requireMask: 2, setMask: 1, clearMask: 2 },
        ],
      },
    ],
  });
  // In state 11 both conditional effects trigger: bit0 is set and cleared
  // simultaneously -> mutex -> action rejected in this state.
  assert.equal(applyAction(p, { bits: 3, res: [] }, p.actions[0]!), null);
});

test("finite resources: consumption and insufficiency", () => {
  const p = normalizeProblem({
    bits: 1,
    initial: 0,
    goal: {},
    resources: { fuel: 1 },
    actions: [
      { name: "burn", setMask: 1, cost: { fuel: 1 } },
      { name: "free", setMask: 1 },
    ],
  });
  const s0 = initialState(p);
  const s1 = applyAction(p, s0, p.actions[0]!);
  assert.deepEqual(s1, { bits: 1, res: [0] });
  // fuel exhausted: burn no longer applicable
  assert.equal(applyAction(p, s1!, p.actions[0]!), null);
  // free action still applicable
  assert.ok(applyAction(p, s1!, p.actions[1]!));
});

test("goal check respects require and forbid masks", () => {
  const p = normalizeProblem({
    bits: 2,
    initial: 0,
    goal: { requireMask: 2, forbidMask: 1 },
    actions: [{ name: "a" }],
  });
  assert.equal(isGoal(p, 2), true);
  assert.equal(isGoal(p, 3), false);
  assert.equal(isGoal(p, 0), false);
});
