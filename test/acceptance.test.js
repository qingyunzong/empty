import test from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/interpreter.js";
import { canonical } from "../src/enumerate.js";

const IDS = { team: "T1", station: "S1", robot: "R1" };

function permutations(items) {
  if (items.length <= 1) return [items];
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) out.push([items[i], ...tail]);
  }
  return out;
}

test("A: 开门状态下自动启动被拒绝，关门后允许", () => {
  const events = [
    { seq: 1, clock: 0, source: "hmi", type: "key_grant", key: "K1", scope: "team", scopeId: "T1", perms: ["auto"] },
    { seq: 2, clock: 1, source: "hmi", type: "mode_request", mode: "auto" },
    { seq: 3, clock: 2, source: "plc", type: "auto_start", ...IDS },
  ];
  const first = run(events);
  const rejected = first.violations.find((v) => v.type === "illegal_auto_start");
  assert.ok(rejected, "auto_start with door open must be rejected");
  assert.ok(rejected.reasons.includes("door_open"));
  assert.equal(first.state.production, false);

  const second = run([
    ...events,
    { seq: 4, clock: 3, source: "plc", type: "door", state: "closed" },
    { seq: 5, clock: 4, source: "plc", type: "auto_start", ...IDS },
  ]);
  assert.equal(second.state.production, true);
  assert.equal(second.state.speed, 800);
  assert.equal(second.violations.filter((v) => v.type === "illegal_auto_start").length, 1);
});

test("B: 钥匙撤销立即生效，重新授权后流程恢复", () => {
  const events = [
    { seq: 1, clock: 0, source: "hmi", type: "key_grant", key: "K1", scope: "robot", scopeId: "R1", perms: ["auto"] },
    { seq: 2, clock: 1, source: "plc", type: "door", state: "closed" },
    { seq: 3, clock: 2, source: "hmi", type: "mode_request", mode: "auto" },
    { seq: 4, clock: 3, source: "plc", type: "auto_start", ...IDS },
    { seq: 5, clock: 4, source: "safety", type: "key_revoke", key: "K1" },
    { seq: 6, clock: 5, source: "plc", type: "auto_start", ...IDS },
    { seq: 7, clock: 6, source: "hmi", type: "key_grant", key: "K1", scope: "robot", scopeId: "R1", perms: ["auto"] },
    { seq: 8, clock: 8, source: "plc", type: "auto_start", ...IDS },
  ];
  const { transitions, violations, state } = run(events);

  assert.equal(state.production, true, "production resumes after re-grant and decel completion");

  const revokeIndex = transitions.findIndex((t) => t.kind === "key_revoke");
  assert.ok(revokeIndex >= 0);
  assert.equal(transitions[revokeIndex].snapshot.keys.length, 0, "revocation is immediate in snapshot");

  const denied = violations.filter((v) => v.type === "illegal_auto_start");
  assert.equal(denied.length, 1);
  assert.ok(denied[0].reasons.includes("no_permission"));
  assert.ok(denied[0].reasons.includes("decel_in_progress"));

  assert.ok(transitions.some((t) => t.kind === "decel_start" && t.start === 4 && t.end === 7));
  assert.ok(transitions.some((t) => t.kind === "decel_complete" && t.end === 7));

  const starts = transitions.filter((t) => t.kind === "production" && t.started === true);
  assert.equal(starts.length, 2, "started once before revoke and once after recovery");
});

test("C: 同一逻辑时钟三事件，输出与输入顺序无关", () => {
  const base = [
    { seq: 1, clock: 5, source: "plc", type: "door", state: "open" },
    { seq: 2, clock: 5, source: "hmi", type: "mode_request", mode: "auto" },
    { seq: 3, clock: 5, source: "plc", type: "auto_start", ...IDS },
  ];
  const expected = canonical(run(base));
  for (const perm of permutations(base)) {
    assert.equal(canonical(run(perm)), expected, `order ${perm.map((e) => e.seq)} must match`);
  }
  const { transitions, violations, state } = run(base);
  assert.equal(state.mode, "auto");
  assert.equal(state.door, "open");
  assert.equal(state.production, false);
  assert.ok(transitions.some((t) => t.kind === "door"));
  assert.ok(transitions.some((t) => t.kind === "mode" && t.to === "auto"));
  const illegal = violations.find((v) => v.type === "illegal_auto_start");
  assert.ok(illegal.reasons.includes("door_open"));
});

test("C2: 同时钟冲突模式请求按(安全等级,来源,序号)决议并记录丢弃", () => {
  const base = [
    { seq: 1, clock: 2, source: "hmi", type: "mode_request", mode: "auto" },
    { seq: 2, clock: 2, source: "plc", type: "mode_request", mode: "teach" },
    { seq: 3, clock: 2, source: "plc", type: "mode_request", mode: "maintenance" },
  ];
  const expected = canonical(run(base));
  for (const perm of permutations(base)) {
    assert.equal(canonical(run(perm)), expected);
  }
  const { transitions, violations, state } = run(base);
  assert.equal(state.mode, "auto", "source hmi sorts before plc and wins");
  assert.equal(transitions.filter((t) => t.kind === "mode").length, 1);
  const discards = violations.filter((v) => v.type === "event_discarded" && v.reason === "concurrent_mode_conflict");
  assert.equal(discards.length, 2);
  assert.ok(discards.every((d) => d.winner === 1));
});
