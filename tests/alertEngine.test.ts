import assert from "node:assert/strict";
import test from "node:test";
import { AlertEngine } from "../src/alertEngine.ts";
import type { AlertEvent, SeriesEvent } from "../src/types.ts";

const obs = (tick: number, value: number): SeriesEvent => ({ kind: "observation", tick, value });
const corr = (tick: number, value: number): SeriesEvent => ({ kind: "correction", tick, value });
const miss = (tick: number): SeriesEvent => ({ kind: "missing", tick });

const types = (events: AlertEvent[]) => events.map((e) => e.type);

test("值大于阈值持续至少 d 才输出区间", () => {
  const engine = new AlertEngine(10, 3);
  // 两个 tick 高于阈值,不足 d=3,无告警
  assert.deepEqual(engine.ingest([obs(1, 11), obs(2, 12)]), []);
  // 第三个 tick 到达,持续满 3 个 tick,告警升起
  const raised = engine.ingest([obs(3, 13)]);
  assert.deepEqual(types(raised), ["raised"]);
  assert.equal(raised[0].alert.startTick, 1);
  assert.equal(raised[0].alert.endTick, 3);
  assert.equal(raised[0].alert.durationTicks, 3);
  // 区间随高于阈值的 tick 继续延长
  const extended = engine.ingest([obs(4, 14)]);
  assert.deepEqual(types(extended), ["extended"]);
  assert.equal(extended[0].type === "extended" && extended[0].previousEnd, 3);
  assert.equal(extended[0].alert.endTick, 4);
  // 跌破阈值,区间封闭,不再变化
  assert.deepEqual(engine.ingest([obs(5, 5)]), []);
  assert.deepEqual(
    engine.activeAlerts().map((a) => [a.startTick, a.endTick]),
    [[1, 4]],
  );
});

test("缺失打断持续区间", () => {
  const engine = new AlertEngine(10, 2);
  // tick 2 隐式缺失(无数据),把序列切成两段各 2 tick 的运行
  const events = engine.ingest([obs(1, 11), obs(2, 12), obs(4, 13), obs(5, 14)]);
  assert.deepEqual(types(events), ["raised", "raised"]);
  assert.deepEqual(
    engine.activeAlerts().map((a) => [a.startTick, a.endTick]),
    [[1, 2], [4, 5]],
  );
  // 显式 missing 事件同样打断
  const engine2 = new AlertEngine(10, 3);
  engine2.ingest([obs(1, 11), obs(2, 12), obs(3, 13), obs(4, 14)]);
  assert.equal(engine2.activeAlerts().length, 1);
  const retracted = engine2.ingest([miss(2)]);
  assert.deepEqual(types(retracted), ["retracted"]);
  assert.equal(engine2.activeAlerts().length, 0);
});

test("同 tick 先应用更正再判定", () => {
  // 同一批次内,观测在前更正在后:按更正后的低值判定,不告警
  const engine = new AlertEngine(10, 1);
  assert.deepEqual(engine.ingest([obs(1, 99), corr(1, 1)]), []);
  assert.equal(engine.activeAlerts().length, 0);
  // 顺序反过来(更正在前观测在后)也一样:更正优先于观测
  const engine2 = new AlertEngine(10, 1);
  assert.deepEqual(engine2.ingest([corr(2, 1), obs(2, 99)]), []);
  assert.equal(engine2.activeAlerts().length, 0);
  // 更正为高值则按高值判定
  const engine3 = new AlertEngine(10, 1);
  const raised = engine3.ingest([obs(1, 1), corr(1, 99)]);
  assert.deepEqual(types(raised), ["raised"]);
});

test("迟到事件撤回告警", () => {
  const engine = new AlertEngine(10, 3);
  engine.ingest([obs(1, 11), obs(2, 12), obs(3, 13), obs(4, 14), obs(5, 15)]);
  assert.deepEqual(
    engine.activeAlerts().map((a) => [a.startTick, a.endTick]),
    [[1, 5]],
  );
  // 迟到的更正把 tick 3 拉低到阈值以下,运行被打断且两段都不足 d=3
  const events = engine.ingest([corr(3, 0)]);
  assert.deepEqual(types(events), ["retracted"]);
  assert.equal(events[0].alert.startTick, 1);
  assert.equal(events[0].alert.endTick, 5);
  assert.equal(engine.activeAlerts().length, 0);
  // 迟到的 missing 事件同样撤回
  const engine2 = new AlertEngine(10, 2);
  engine2.ingest([obs(1, 11), obs(2, 12), obs(3, 13)]);
  assert.equal(engine2.activeAlerts().length, 1);
  assert.deepEqual(types(engine2.ingest([miss(2)])), ["retracted"]);
  assert.equal(engine2.activeAlerts().length, 0);
});

test("迟到更正使区间起点变化时撤回旧告警并升起新告警", () => {
  const engine = new AlertEngine(10, 2);
  engine.ingest([obs(1, 11), obs(2, 12), obs(3, 13)]);
  // 迟到更正:tick 1 实际低于阈值,运行起点从 1 变为 2
  const events = engine.ingest([corr(1, 0)]);
  assert.deepEqual(types(events), ["retracted", "raised"]);
  assert.equal(events[0].alert.startTick, 1);
  assert.equal(events[1].alert.startTick, 2);
  assert.equal(events[1].alert.endTick, 3);
});

test("告警携带起止证据", () => {
  const engine = new AlertEngine(10, 2);
  engine.ingest([obs(1, 5), obs(2, 11), obs(3, 12), obs(4, 6), obs(6, 20), obs(7, 21)]);
  const [first, second] = engine.activeAlerts();
  // 第一段 [2,3]:起点证据为 tick2 的值与其前的低于阈值 tick,终点证据为 tick3 与其后的低于阈值 tick
  assert.deepEqual(first.startEvidence, {
    sample: { tick: 2, value: 11 },
    before: { tick: 1, value: 5, reason: "below-threshold" },
  });
  assert.deepEqual(first.endEvidence, {
    sample: { tick: 3, value: 12 },
    after: { tick: 4, value: 6, reason: "below-threshold" },
  });
  // 第二段 [6,7]:起点前是缺失(tick5 无数据),终点后数据未到,状态为 open
  assert.deepEqual(second.startEvidence.before, { tick: 5, value: null, reason: "missing" });
  assert.deepEqual(second.endEvidence.after, { tick: 8, value: null, reason: "open" });
  // 序列最左端的区间起点证据为 series-start
  const engine2 = new AlertEngine(10, 1);
  engine2.ingest([obs(3, 11)]);
  assert.deepEqual(engine2.activeAlerts()[0].startEvidence.before, {
    tick: 2,
    value: null,
    reason: "series-start",
  });
});
