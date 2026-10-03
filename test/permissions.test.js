import test from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/interpreter.js";

const grant = (seq, clock, scope, scopeId, perms = ["auto"], key = "K1") => ({
  seq,
  clock,
  source: "hmi",
  type: "key_grant",
  key,
  scope,
  scopeId,
  perms,
});
const start = (seq, clock, team = "T1", station = "S1", robot = "R1") => ({
  seq,
  clock,
  source: "plc",
  type: "auto_start",
  team,
  station,
  robot,
});
const prepare = [grant(1, 0, "team", "T1"), { seq: 2, clock: 1, source: "plc", type: "door", state: "closed" }, { seq: 3, clock: 2, source: "hmi", type: "mode_request", mode: "auto" }];

test("权限继承: 班组授权覆盖组内机器人", () => {
  const ok = run([...prepare, start(4, 3)]);
  assert.equal(ok.state.production, true);
});

test("权限继承: 班组外机器人不继承", () => {
  const denied = run([...prepare, start(4, 3, "T2")]);
  const v = denied.violations.find((x) => x.type === "illegal_auto_start");
  assert.ok(v.reasons.includes("no_permission"));
  assert.equal(denied.state.production, false);
});

test("权限继承: 工位授权只覆盖本工位", () => {
  const events = [
    grant(1, 0, "station", "S1"),
    { seq: 2, clock: 1, source: "plc", type: "door", state: "closed" },
    { seq: 3, clock: 2, source: "hmi", type: "mode_request", mode: "auto" },
    start(4, 3, "T1", "S2"),
    start(5, 4, "T1", "S1"),
  ];
  const { violations, state } = run(events);
  assert.ok(violations.find((v) => v.type === "illegal_auto_start" && v.station === "S2"));
  assert.equal(state.production, true, "S1 robot starts via station grant");
});

test("权限继承: 机器人级授权仅覆盖本机器人", () => {
  const events = [
    grant(1, 0, "robot", "R1"),
    { seq: 2, clock: 1, source: "plc", type: "door", state: "closed" },
    { seq: 3, clock: 2, source: "hmi", type: "mode_request", mode: "auto" },
    start(4, 3, "T1", "S1", "R2"),
    start(5, 4, "T1", "S1", "R1"),
  ];
  const { violations, state } = run(events);
  assert.ok(violations.find((v) => v.type === "illegal_auto_start" && v.robot === "R2"));
  assert.equal(state.production, true);
});

test("权限继承: 班组与工位授权取并集", () => {
  const events = [
    grant(1, 0, "team", "T1", ["teach"], "K1"),
    grant(2, 1, "station", "S1", ["auto"], "K2"),
    { seq: 3, clock: 2, source: "plc", type: "door", state: "closed" },
    { seq: 4, clock: 3, source: "hmi", type: "mode_request", mode: "auto" },
    start(5, 4),
  ];
  assert.equal(run(events).state.production, true, "station grant adds auto on top of team teach");
});

test("钥匙撤销立即生效且减速窗口必须完成", () => {
  const events = [
    ...prepare,
    start(4, 3),
    { seq: 5, clock: 4, source: "safety", type: "key_revoke", key: "K1" },
    { seq: 6, clock: 5, source: "hmi", type: "mode_request", mode: "teach" },
    { seq: 7, clock: 6, source: "hmi", type: "speed_request", value: 100 },
    { seq: 8, clock: 7, source: "hmi", type: "mode_request", mode: "teach" },
  ];
  const { transitions, violations, state } = run(events);

  const denied = violations.find((v) => v.type === "mode_transition_denied");
  assert.ok(denied, "mode jump during decel window is denied");
  assert.equal(denied.reason, "decel_in_progress");
  assert.equal(denied.decelEnd, 7);

  const speedDrop = violations.find((v) => v.type === "event_discarded" && v.reason === "decel_in_progress");
  assert.ok(speedDrop, "speed command during decel window is discarded");

  const complete = transitions.find((t) => t.kind === "decel_complete");
  assert.ok(complete, "decel window completes at clock 7");
  assert.equal(complete.snapshot.speed, 0);

  const modeChange = transitions.find((t) => t.kind === "mode" && t.to === "teach");
  assert.ok(modeChange, "mode change allowed after window completes");
  assert.equal(state.mode, "teach");
});

test("维护模式: 允许开门, 禁止自动启动与速度指令", () => {
  const events = [
    { seq: 1, clock: 0, source: "plc", type: "door", state: "open" },
    { seq: 2, clock: 1, source: "plc", type: "auto_start", team: "T1", station: "S1", robot: "R1" },
    { seq: 3, clock: 2, source: "hmi", type: "speed_request", value: 100 },
  ];
  const { transitions, violations, state } = run(events);
  assert.ok(transitions.some((t) => t.kind === "door" && t.state === "open"), "door open allowed in maintenance");
  assert.ok(!violations.some((v) => v.event === "door"), "no violation for opening door");
  const illegal = violations.find((v) => v.type === "illegal_auto_start");
  assert.ok(illegal.reasons.includes("mode_not_auto"));
  assert.ok(violations.some((v) => v.type === "event_discarded" && v.reason === "maintenance_mode"));
  assert.equal(state.production, false);
});

test("示教限速与产能规则冲突时安全规则胜", () => {
  const events = [
    { seq: 1, clock: 0, source: "hmi", type: "mode_request", mode: "teach" },
    { seq: 2, clock: 1, source: "hmi", type: "speed_request", value: 600 },
    { seq: 3, clock: 2, source: "hmi", type: "speed_request", value: 200 },
  ];
  const { transitions, violations, state } = run(events);
  const conflict = violations.find((v) => v.type === "rule_conflict");
  assert.ok(conflict, "conflict between teach cap and throughput target is logged");
  assert.equal(conflict.winner, "safety_teach_speed_cap");
  assert.equal(conflict.loser, "throughput_min");
  assert.equal(conflict.commanded, 250);
  const capped = transitions.find((t) => t.kind === "speed" && t.requested === 600);
  assert.equal(capped.commanded, 250, "safety rule wins over throughput");
  assert.equal(state.speed, 200, "subsequent in-limit request applies");
});

test("自动模式运行中光幕遮挡触发安全停机", () => {
  const events = [
    ...prepare,
    start(4, 3),
    { seq: 5, clock: 4, source: "plc", type: "curtain", state: "blocked" },
  ];
  const { transitions, state } = run(events);
  const stop = transitions.find((t) => t.kind === "safety_stop");
  assert.ok(stop);
  assert.equal(stop.trigger, "curtain_blocked");
  assert.equal(state.production, false);
  assert.equal(state.speed, 0);
});

test("自动模式运行中开门触发安全停机", () => {
  const events = [...prepare, start(4, 3), { seq: 5, clock: 4, source: "plc", type: "door", state: "open" }];
  const { transitions, state } = run(events);
  assert.ok(transitions.some((t) => t.kind === "safety_stop" && t.trigger === "door_open"));
  assert.equal(state.production, false);
});
