import test from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/interpreter.js";
import { minimalCounterexample, reduceCounterexample } from "../src/counterexample.js";

const IDS = { team: "T1", station: "S1", robot: "R1" };

test("反例: 返回导致非法自动启动的最少事件前缀", () => {
  const events = [
    { seq: 1, clock: 0, source: "plc", type: "door", state: "closed" },
    { seq: 2, clock: 1, source: "hmi", type: "mode_request", mode: "auto" },
    { seq: 3, clock: 2, source: "plc", type: "auto_start", ...IDS },
    { seq: 4, clock: 3, source: "hmi", type: "key_grant", key: "K1", scope: "team", scopeId: "T1", perms: ["auto"] },
    { seq: 5, clock: 4, source: "plc", type: "auto_start", ...IDS },
  ];
  const result = minimalCounterexample(events);
  assert.ok(result.found);
  assert.equal(result.length, 3, "first three events are the minimal prefix");
  assert.equal(result.violation.type, "illegal_auto_start");
  assert.ok(result.violation.reasons.includes("no_permission"));

  for (let k = 1; k < result.length; k += 1) {
    const { violations } = run(events.slice(0, k));
    assert.ok(!violations.some((v) => v.type === "illegal_auto_start"), `prefix of ${k} must be clean`);
  }

  const { state } = run(events);
  assert.equal(state.production, true, "trace recovers after key grant");
});

test("反例: 单事件即触发时前缀长度为 1", () => {
  const events = [{ seq: 1, clock: 0, source: "plc", type: "auto_start", ...IDS }];
  const result = minimalCounterexample(events);
  assert.ok(result.found);
  assert.equal(result.length, 1);
});

test("反例: 合法轨迹返回 found=false", () => {
  const events = [
    { seq: 1, clock: 0, source: "hmi", type: "key_grant", key: "K1", scope: "team", scopeId: "T1", perms: ["auto"] },
    { seq: 2, clock: 1, source: "plc", type: "door", state: "closed" },
    { seq: 3, clock: 2, source: "hmi", type: "mode_request", mode: "auto" },
    { seq: 4, clock: 3, source: "plc", type: "auto_start", ...IDS },
  ];
  assert.equal(minimalCounterexample(events).found, false);
});

test("反例: 贪心约简结果仍触发且不可再约简", () => {
  const prefix = [
    { seq: 1, clock: 0, source: "plc", type: "curtain", state: "clear" },
    { seq: 2, clock: 1, source: "plc", type: "door", state: "closed" },
    { seq: 3, clock: 2, source: "hmi", type: "mode_request", mode: "auto" },
    { seq: 4, clock: 3, source: "plc", type: "curtain", state: "clear" },
    { seq: 5, clock: 4, source: "plc", type: "auto_start", ...IDS },
  ];
  const reduced = reduceCounterexample(prefix);
  assert.ok(reduced.length < prefix.length, "redundant curtain events are dropped");
  assert.equal(reduced[reduced.length - 1].type, "auto_start");
  const { violations } = run(reduced);
  assert.ok(violations.some((v) => v.type === "illegal_auto_start"), "reduced sequence still triggers");
  for (let i = 0; i < reduced.length - 1; i += 1) {
    const smaller = [...reduced.slice(0, i), ...reduced.slice(i + 1)];
    const check = run(smaller);
    assert.ok(
      !check.violations.some((v) => v.type === "illegal_auto_start"),
      `removing event ${i} must break the counterexample`,
    );
  }
});
