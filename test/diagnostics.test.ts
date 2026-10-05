import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DiagnosticStore,
  Diagnostic,
  Report,
} from "../src/diagnostics.js";

function makeReport(overrides: Partial<Report>): Report {
  return {
    sourceId: "src-a",
    phase: "parse",
    range: { start: 0, end: 10 },
    reason: "E001",
    message: "boom",
    ...overrides,
  };
}

test("同一来源重复上报同一错误按来源ID合并为一份证据", () => {
  const store = new DiagnosticStore();
    store.report(makeReport({}));
  store.report(makeReport({}));
  store.report(makeReport({}));
  const list = store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].evidences.length, 1);
  assert.deepEqual(list[0].evidences[0], {
    sourceId: "src-a",
    phase: "parse",
    message: "boom",
  });
});

test("范围相邻但原因不同的诊断不能合并", () => {
  const store = new DiagnosticStore();
  store.report(makeReport({ range: { start: 0, end: 10 }, reason: "E001" }));
  store.report(makeReport({ range: { start: 10, end: 20 }, reason: "E002" }));
  const list = store.list();
  assert.equal(list.length, 2);
  assert.deepEqual(
    list.map((d) => [d.range.start, d.range.end, d.reason]),
    [
      [0, 10, "E001"],
      [10, 20, "E002"],
    ],
  );
});

test("范围相同但原因不同的诊断不能合并", () => {
  const store = new DiagnosticStore();
  store.report(makeReport({ reason: "E001" }));
  store.report(makeReport({ reason: "E002" }));
  assert.equal(store.list().length, 2);
});

test("同一错误被多个阶段引用时保留每份证据", () => {
  const store = new DiagnosticStore();
  store.report(makeReport({ phase: "parse", message: "parse failed" }));
  store.report(makeReport({ phase: "lint", message: "lint failed" }));
  store.report(makeReport({ phase: "codegen", message: "codegen failed" }));
  const list = store.list();
  assert.equal(list.length, 1);
  assert.deepEqual(
    list[0].evidences.map((e) => e.phase),
    ["codegen", "lint", "parse"],
  );
});

test("撤回来源只移除该来源的引用，其他来源证据保留", () => {
  const store = new DiagnosticStore();
  store.report(makeReport({ sourceId: "src-a", message: "from a" }));
  store.report(makeReport({ sourceId: "src-b", message: "from b" }));
  store.report(
    makeReport({ sourceId: "src-a", reason: "E002", message: "a only" }),
  );
  store.withdraw("src-a");
  const list = store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].reason, "E001");
  assert.deepEqual(
    list[0].evidences.map((e) => e.sourceId),
    ["src-b"],
  );
});

test("所有来源都撤回后诊断消失", () => {
  const store = new DiagnosticStore();
  store.report(makeReport({ sourceId: "src-a" }));
  store.report(makeReport({ sourceId: "src-b" }));
  store.withdraw("src-a");
  store.withdraw("src-b");
  assert.equal(store.list().length, 0);
});

test("撤回不存在的来源不影响现有诊断", () => {
  const store = new DiagnosticStore();
  store.report(makeReport({}));
  store.withdraw("ghost");
  assert.equal(store.list().length, 1);
});

test("输出稳定排序，与插入顺序无关", () => {
  const reports: Report[] = [
    makeReport({ sourceId: "s2", range: { start: 5, end: 8 }, reason: "E2" }),
    makeReport({ sourceId: "s1", range: { start: 0, end: 3 }, reason: "E9" }),
    makeReport({ sourceId: "s3", range: { start: 0, end: 3 }, reason: "E1" }),
    makeReport({ sourceId: "s1", range: { start: 5, end: 8 }, reason: "E2" }),
  ];
  const forward = new DiagnosticStore();
  for (const r of reports) forward.report(r);
  const reverse = new DiagnosticStore();
  for (const r of [...reports].reverse()) reverse.report(r);
  const a = forward.list();
  const b = reverse.list();
  assert.deepEqual(a, b);
  assert.deepEqual(
    a.map((d) => [d.range.start, d.range.end, d.reason]),
    [
      [0, 3, "E1"],
      [0, 3, "E9"],
      [5, 8, "E2"],
    ],
  );
  assert.deepEqual(
    a[2].evidences.map((e) => e.sourceId),
    ["s1", "s2"],
  );
});

// ---- 随机撤回 vs 全量集合模型 ----

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 全量集合模型：维护存活事件日志，撤回时剔除该来源全部事件后从零重建。 */
function modelList(events: readonly Report[]): Diagnostic[] {
  const replay = new DiagnosticStore();
  for (const e of events) {
    replay.report(e);
  }
  return replay.list();
}

test("随机上报与撤回序列与全量集合模型一致", () => {
  const sources = ["s1", "s2", "s3", "s4"];
  const phases = ["parse", "lint", "codegen"];
  const reasons = ["E001", "E002", "E003"];
  const messages = ["m1", "m2", "m3"];

  for (let seed = 1; seed <= 50; seed++) {
    const rand = mulberry32(seed);
    const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
    const store = new DiagnosticStore();
    let events: Report[] = [];

    for (let step = 0; step < 200; step++) {
      if (rand() < 0.25) {
        const sourceId = pick(sources);
        store.withdraw(sourceId);
        events = events.filter((e) => e.sourceId !== sourceId);
      } else {
        const start = Math.floor(rand() * 5) * 10;
        const report = makeReport({
          sourceId: pick(sources),
          phase: pick(phases),
          range: { start, end: start + 10 },
          reason: pick(reasons),
          message: pick(messages),
        });
        store.report(report);
        events.push(report);
      }
      assert.deepEqual(
        store.list(),
        modelList(events),
        `seed=${seed} step=${step}`,
      );
    }
  }
});
