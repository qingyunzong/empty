import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLASSIFICATION_TABLE,
  DIAGNOSIS_CATEGORIES,
  EVENT_KINDS,
  EVENT_STATUSES,
  EventKind,
  EventStatus,
  EventValidationError,
  classifyEvent,
  diagnose,
} from "../src/index.js";

/** 测试内独立维护的期望表，与实现中的表互相核对（有限表穷举）。 */
const EXPECTED_TABLE: Record<EventKind, Partial<Record<EventStatus, string | null>>> = {
  precondition_check: {
    ok: null,
    failed: "missing_precondition",
    timeout: null,
    interrupted: null,
    skipped: null,
  },
  communication: {
    ok: null,
    failed: "communication_interruption",
    timeout: "communication_interruption",
    interrupted: "communication_interruption",
    skipped: null,
  },
  assertion: {
    ok: null,
    failed: "assertion_failure",
    timeout: null,
    interrupted: null,
    skipped: null,
  },
  lifecycle: {
    ok: null,
    failed: null,
    timeout: null,
    interrupted: null,
    skipped: null,
  },
};

test("有限表穷举核对：kind × status 全组合分类一致", () => {
  let checked = 0;
  for (const kind of EVENT_KINDS) {
    for (const status of EVENT_STATUSES) {
      const expected = EXPECTED_TABLE[kind][status] ?? null;
      assert.equal(
        classifyEvent({ kind, status }),
        expected,
        `classifyEvent(${kind}, ${status})`,
      );
      assert.equal(
        CLASSIFICATION_TABLE[kind][status] ?? null,
        expected,
        `CLASSIFICATION_TABLE[${kind}][${status}]`,
      );
      checked += 1;
    }
  }
  assert.equal(checked, EVENT_KINDS.length * EVENT_STATUSES.length);
});

test("诊断类别集合恰为四类", () => {
  assert.deepEqual([...DIAGNOSIS_CATEGORIES].sort(), [
    "assertion_failure",
    "communication_interruption",
    "missing_precondition",
    "unknown",
  ]);
});

test("没有执行证据（空输入）→ unknown", () => {
  const d = diagnose([]);
  assert.equal(d.category, "unknown");
  assert.equal(d.reason, "no_execution_evidence");
  assert.equal(d.rootCause, null);
  assert.deepEqual(d.causalChain, []);
});

test("有执行证据但无致终止事件 → unknown", () => {
  const d = diagnose([
    { seq: 1, kind: "lifecycle", status: "ok", name: "start" },
    { seq: 2, kind: "precondition_check", status: "ok", name: "env" },
    { seq: 3, kind: "communication", status: "ok", name: "ping" },
  ]);
  assert.equal(d.category, "unknown");
  assert.equal(d.reason, "no_terminating_event");
  assert.equal(d.rootCause, null);
});

test("前置缺失分类", () => {
  const d = diagnose([
    { seq: 1, kind: "lifecycle", status: "ok", name: "start" },
    { seq: 2, kind: "precondition_check", status: "failed", name: "license" },
  ]);
  assert.equal(d.category, "missing_precondition");
  assert.equal(d.reason, "earliest_terminating_event");
  assert.equal(d.rootCause?.seq, 2);
});

test("通信中断分类（failed / timeout / interrupted 三态）", () => {
  for (const status of ["failed", "timeout", "interrupted"] as const) {
    const d = diagnose([
      { seq: 1, kind: "communication", status, name: "uplink" },
    ]);
    assert.equal(d.category, "communication_interruption", `status=${status}`);
  }
});

test("断言失败分类", () => {
  const d = diagnose([
    { seq: 1, kind: "assertion", status: "failed", name: "postcondition" },
  ]);
  assert.equal(d.category, "assertion_failure");
  assert.equal(d.rootCause?.name, "postcondition");
});

test("多原因按最早直接致终止事件（与输入顺序无关）", () => {
  const d = diagnose([
    { seq: 9, kind: "assertion", status: "failed", name: "late-assert" },
    { seq: 4, kind: "communication", status: "timeout", name: "early-timeout" },
    { seq: 7, kind: "precondition_check", status: "failed", name: "mid-pre" },
  ]);
  assert.equal(d.category, "communication_interruption");
  assert.equal(d.rootCause?.seq, 4);
  assert.equal(d.rootCause?.name, "early-timeout");
});

test("不从文字猜身份：message 含他类字样不改变分类", () => {
  const d = diagnose([
    {
      seq: 1,
      kind: "assertion",
      status: "failed",
      name: "check",
      message: "precondition missing: connection reset by peer",
    },
  ]);
  assert.equal(d.category, "assertion_failure");
});

test("不从文字猜身份：kind 越出有限表即拒绝，不做推断", () => {
  assert.throws(
    () =>
      diagnose([
        { seq: 1, kind: "precondition missing", status: "failed", name: "x" },
      ]),
    EventValidationError,
  );
});

test("因果链：有 causedBy 引用时回溯完整祖先链", () => {
  const d = diagnose([
    { seq: 1, kind: "lifecycle", status: "ok", name: "start" },
    { seq: 2, kind: "precondition_check", status: "ok", name: "env", causedBy: [1] },
    { seq: 3, kind: "communication", status: "ok", name: "dial", causedBy: [2] },
    { seq: 4, kind: "communication", status: "timeout", name: "rpc", causedBy: [3] },
    { seq: 5, kind: "assertion", status: "failed", name: "unrelated-late" },
  ]);
  assert.equal(d.category, "communication_interruption");
  assert.deepEqual(
    d.causalChain.map((l) => l.name),
    ["start", "env", "dial", "rpc"],
  );
  const last = d.causalChain[d.causalChain.length - 1];
  assert.equal(last?.category, "communication_interruption");
});

test("因果链：无 causedBy 时退化为致终止事件前的时序记录", () => {
  const d = diagnose([
    { seq: 1, kind: "lifecycle", status: "ok", name: "start" },
    { seq: 2, kind: "assertion", status: "failed", name: "boom" },
    { seq: 3, kind: "lifecycle", status: "ok", name: "after" },
  ]);
  assert.deepEqual(
    d.causalChain.map((l) => l.seq),
    [1, 2],
  );
});

test("非法输入一律拒绝：非数组、缺字段、重复 seq、非法 causedBy", () => {
  assert.throws(() => diagnose("not-an-array"), EventValidationError);
  assert.throws(() => diagnose([{ seq: 1, kind: "assertion", status: "failed" }]), EventValidationError);
  assert.throws(
    () =>
      diagnose([
        { seq: 1, kind: "assertion", status: "failed", name: "a" },
        { seq: 1, kind: "assertion", status: "failed", name: "b" },
      ]),
    EventValidationError,
  );
  assert.throws(
    () =>
      diagnose([
        { seq: 1, kind: "assertion", status: "failed", name: "a", causedBy: ["x"] },
      ]),
    EventValidationError,
  );
});
