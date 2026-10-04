import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFsm } from "../src/fsm.js";
import { replay } from "../src/oracle.js";

const fsm = parseFsm({
  initial: "idle",
  failureStates: ["error"],
  transitions: {
    idle: { open: "opened", noop: "idle" },
    opened: { read: "opened", lock: "locked", close: "idle", noop: "opened" },
    locked: { write: "error", unlock: "opened", noop: "locked" },
    error: { reset: "idle" },
  },
});

test("legal history ending outside failure states passes", () => {
  const r = replay(fsm, ["open", "read", "close"]);
  assert.equal(r.verdict, "pass");
  assert.equal(r.finalState, "idle");
});

test("legal history ending in a failure state fails", () => {
  const r = replay(fsm, ["open", "lock", "write"]);
  assert.equal(r.verdict, "fail");
  assert.equal(r.finalState, "error");
});

test("illegal history is invalid, never a failure", () => {
  const first = replay(fsm, ["write"]);
  assert.equal(first.verdict, "invalid");
  assert.equal(first.illegalAt, 0);

  const later = replay(fsm, ["open", "lock", "write", "write"]);
  assert.equal(later.verdict, "invalid");
  assert.equal(later.illegalAt, 3);

  assert.ok(first.verdict !== "fail");
  assert.ok(later.verdict !== "fail");
});

test("empty history passes when initial state is not a failure state", () => {
  assert.equal(replay(fsm, []).verdict, "pass");
});
