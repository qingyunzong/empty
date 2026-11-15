import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createCollector,
  type RowSnapshot,
  type WindowObservation,
} from "./index.js";

function rows(...entries: Array<[string, string, number?]>): RowSnapshot[] {
  return entries.map(([key, version, index]) => ({ key, version, index }));
}

function win(
  entries: Array<[string, string, number?]>,
  anchor: WindowObservation["anchor"] = {},
): WindowObservation {
  return { anchor, rows: rows(...entries) };
}

describe("VirtualTableCollector", () => {
  it("DOM 节点复用与窗口重叠不计为新行", () => {
    const c = createCollector({ expectedTotal: 4 });
    c.beginRound("gen-1");
    const first = c.observe(win([["a", "v1", 0], ["b", "v1", 1]]), "gen-1");
    assert.deepEqual(first.newKeys, ["a", "b"]);

    // 滚动一格：b 复用了 a 的 DOM 节点，c 是新行。
    const second = c.observe(
      {
        anchor: { firstKey: "b", firstIndex: 1, scrollTop: 40 },
        rows: [
          { key: "b", version: "v1", index: 1, nodeId: "node-0" },
          { key: "c", version: "v1", index: 2, nodeId: "node-1" },
        ],
      },
      "gen-1",
    );
    assert.deepEqual(second.newKeys, ["c"]);
    assert.deepEqual(second.reusedKeys, ["b"]);
    c.closeRound();
    assert.equal(c.status().collected, 3);
  });

  it("达到预期总数即完成并返回缺口", () => {
    const c = createCollector({ expectedTotal: 5 });
    c.beginRound("g");
    c.observe(win([["a", "v1", 0], ["b", "v1", 1], ["c", "v1", 2]]), "g");
    assert.equal(c.status().complete, false);
    c.observe(win([["d", "v1", 3], ["e", "v1", 4]]), "g");
    c.closeRound();
    const status = c.status();
    assert.equal(status.complete, true);
    assert.equal(status.completionReason, "expected-total");
    assert.deepEqual(status.gaps, []);
  });

  it("连续稳定窗口证明完成", () => {
    const c = createCollector({ stableWindowsToComplete: 2 });
    c.beginRound("g");
    c.observe(win([["a", "v1", 0]]), "g");
    assert.equal(c.status().complete, false);
    c.observe(win([["a", "v1", 0]]), "g");
    assert.equal(c.status().complete, false);
    const third = c.observe(win([["a", "v1", 0]]), "g");
    assert.equal(third.stableStreak, 2);
    assert.equal(c.status().complete, true);
    assert.equal(c.status().completionReason, "stable-windows");
  });

  it("版本变化重置稳定计数并更新行数据", () => {
    const c = createCollector({ stableWindowsToComplete: 2 });
    c.beginRound("g");
    c.observe(win([["a", "v1", 0]]), "g");
    c.observe(win([["a", "v1", 0]]), "g");
    const changed = c.observe(win([["a", "v2", 0]]), "g");
    assert.deepEqual(changed.updatedKeys, ["a"]);
    assert.equal(changed.stableStreak, 0);
    c.closeRound();
    const [row] = c.result().rows;
    assert.equal(row.version, "v2");
  });

  it("世代变化废弃未闭合轮次", () => {
    const c = createCollector();
    c.beginRound("sort-asc");
    c.observe(win([["a", "v1", 0], ["b", "v1", 1]]), "sort-asc");
    // 未闭轮就切换排序：缓冲数据被废弃。
    c.beginRound("sort-desc");
    assert.equal(c.status().collected, 0);
    assert.equal(c.status().discardedRounds, 1);
    c.observe(win([["c", "v1", 0]]), "sort-desc");
    c.closeRound();
    assert.deepEqual(
      c.result().rows.map((r) => r.key),
      ["c"],
    );
  });

  it("已闭合轮次在世代变化后保留", () => {
    const c = createCollector();
    c.beginRound("g1");
    c.observe(win([["a", "v1", 0]]), "g1");
    c.closeRound();
    c.beginRound("g2");
    c.observe(win([["b", "v1", 1]]), "g2");
    c.closeRound();
    assert.equal(c.status().collected, 2);
  });

  it("缺口按绝对行号聚合成区间", () => {
    const c = createCollector({ expectedTotal: 10 });
    c.beginRound("g");
    c.observe(win([["a", "v1", 0], ["b", "v1", 1], ["e", "v1", 4], ["h", "v1", 7]]), "g");
    c.closeRound();
    assert.deepEqual(c.status().gaps, [
      { start: 2, end: 3, count: 2 },
      { start: 5, end: 6, count: 2 },
      { start: 8, end: 9, count: 2 },
    ]);
  });

  it("未闭合轮次中的观察对状态可见但不进入已提交结果", () => {
    const c = createCollector();
    c.beginRound("g");
    c.observe(win([["a", "v1", 0]]), "g");
    assert.equal(c.status().collected, 1);
    c.abortRound();
    assert.equal(c.status().collected, 0);
    assert.equal(c.status().discardedRounds, 1);
  });
});
