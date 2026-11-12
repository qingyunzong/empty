import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  collectVirtualList,
  makeRows,
  MemoryVirtualListAdapter,
} from "../index.js";

describe("场景：重排", () => {
  test("视口重排后只接受递增代数，且不产生重复行", async () => {
    const adapter = new MemoryVirtualListAdapter(makeRows("r", 6), {
      pageSize: 3,
      events: [
        // 第 2 次 read（首次 move 之后的读取）之前把 r-0 移到队尾。
        { type: "reorder-before-read", times: 2, id: "r-0", toIndex: 5 },
      ],
    });

    const result = await collectVirtualList(adapter, {
      stableRounds: 2,
      moveBudget: 30,
    });

    assert.equal(result.status, "completed");
    const ids = result.rows.map((row) => row.id);
    assert.equal(new Set(ids).size, ids.length, "同 ID 行不得重复采集");
    assert.deepEqual([...ids].sort(), [
      "r-0",
      "r-1",
      "r-2",
      "r-3",
      "r-4",
      "r-5",
    ]);
    // 首次读取代数 0；第 1 次 move 推进到 1；重排推进到 2。
    assert.ok(result.generation >= 2);
  });
});

describe("场景：删除锚点（stale）", () => {
  test("锚点被移除时 stale 不移动，重新 read 后继续且不计稳定轮次", async () => {
    const adapter = new MemoryVirtualListAdapter(makeRows("r", 6), {
      pageSize: 3,
      events: [
        // 第 1 次 move 之前删除当前视口最后一行 r-2（即本次 move 的锚点）。
        { type: "delete-before-move", times: 1, id: "r-2" },
      ],
    });

    const result = await collectVirtualList(adapter, {
      stableRounds: 2,
      moveBudget: 30,
    });

    assert.equal(result.status, "completed");
    const ids = result.rows.map((row) => row.id);
    // r-2 在删除前已由首次 read 采集，已采集数据保留；
    // 之后所有视口中不再出现该行（采集不重复、不回滚已见数据）。
    assert.deepEqual(ids, ["r-0", "r-1", "r-2", "r-3", "r-4", "r-5"]);
    assert.equal(adapter.rowCount(), 5, "宿主列表中该行已被删除");

    // 适配器视角：第 1 次 move 返回 stale；删除推进代数，滚动继续单调递增。
    assert.ok(adapter.staleMoveCount() >= 1);
    assert.equal(result.generation, adapter.currentGeneration());
    assert.ok(adapter.moveCallCount() >= 1);
  });

  test("stale 后连续 K 轮判定不被提前触发", async () => {
    const adapter = new MemoryVirtualListAdapter(makeRows("r", 8), {
      pageSize: 3,
      events: [
        { type: "delete-before-move", times: 1, id: "r-2" },
        { type: "delete-before-move", times: 3, id: "r-4" },
      ],
    });

    const result = await collectVirtualList(adapter, {
      stableRounds: 3,
      moveBudget: 40,
    });

    assert.equal(result.status, "completed");
    assert.equal(result.rows.length, 8, "删除前已见的行仍保留在采集结果");
    assert.equal(adapter.staleMoveCount(), 2);
    assert.equal(adapter.rowCount(), 6, "宿主列表实际删除了两行");
  });
});

describe("场景：move 响应丢失", () => {
  test("move 成功但响应丢失：read 确认代数增加后读新视口，不重复滚动", async () => {
    const adapter = new MemoryVirtualListAdapter(makeRows("r", 8), {
      pageSize: 3,
      events: [
        // 第 1 次 move：滚动生效、代数推进，但 Promise reject。
        { type: "move-lost", times: 1 },
      ],
    });

    const result = await collectVirtualList(adapter, {
      stableRounds: 2,
      moveBudget: 30,
    });

    assert.equal(result.status, "completed");
    assert.equal(result.rows.length, 8);
    // move 实际只调用了一次“第 1 次移动”；恢复后不得重复同一次滚动，
    // 因此适配器 move 调用次数等于采集器记账次数。
    assert.equal(result.movesUsed, adapter.moveCallCount());
    // 恢复读取发生在第 2 次 read。
    assert.ok(adapter.readCallCount() >= 2);
  });

  test("move 未生效的失败：代数未变，重试同一移动后成功", async () => {
    const adapter = new MemoryVirtualListAdapter(makeRows("r", 8), {
      pageSize: 3,
      events: [
        // 第 1 次 move 在滚动前 reject，代数不变；采集器应重试。
        { type: "move-fail", times: 1 },
      ],
    });

    const result = await collectVirtualList(adapter, {
      stableRounds: 2,
      moveBudget: 30,
    });

    assert.equal(result.status, "completed");
    assert.equal(result.rows.length, 8);
    // 第 1 次调用失败，第 2 次成功，重试消耗额外预算。
    assert.ok(adapter.moveCallCount() >= 2);
    assert.equal(result.movesUsed, adapter.moveCallCount());
  });

  test("响应丢失后 read 也失败：先停止并返回 read-failed", async () => {
    const adapter = new MemoryVirtualListAdapter(makeRows("r", 8), {
      pageSize: 3,
      events: [
        { type: "move-lost", times: 1 },
        // 恢复用的 read（第 2 次 read）失败。
        { type: "read-fail", times: 2 },
      ],
    });

    const result = await collectVirtualList(adapter, {
      stableRounds: 2,
      moveBudget: 30,
    });

    assert.equal(result.status, "read-failed");
    assert.ok(result.movesUsed === 1);
    assert.ok(result.rows.length > 0, "已采集数据仍需返回");
  });
});
