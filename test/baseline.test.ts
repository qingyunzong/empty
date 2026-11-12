import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  collectVirtualList,
  makeRows,
  MemoryVirtualListAdapter,
} from "../index.js";

describe("基线：顺序滚动与终止边界", () => {
  test("完整读完列表后以 completed 结束，采集所有行且有序", async () => {
    const adapter = new MemoryVirtualListAdapter(makeRows("r", 10), {
      pageSize: 3,
    });

    const result = await collectVirtualList(adapter, {
      stableRounds: 3,
      moveBudget: 50,
    });

    assert.equal(result.status, "completed");
    assert.equal(result.rows.length, 10);
    assert.deepEqual(
      result.rows.map((row) => row.id),
      ["r-0", "r-1", "r-2", "r-3", "r-4", "r-5", "r-6", "r-7", "r-8", "r-9"],
    );
    assert.equal(result.movesUsed, adapter.moveCallCount());
    // 列表到底后仍需 K 次无进展移动才终止。
    assert.ok(result.movesUsed >= 10);
  });

  test("连续 K 次有效移动无新 ID 即结束，K=1 时终止最快", async () => {
    const adapter = new MemoryVirtualListAdapter(makeRows("r", 4), {
      pageSize: 4,
    });

    const result = await collectVirtualList(adapter, {
      stableRounds: 1,
      moveBudget: 10,
    });

    assert.equal(result.status, "completed");
    assert.equal(result.rows.length, 4);
    // 首次读取后第一次移动即无新增（视口始终是 4 行），立即结束。
    assert.equal(result.movesUsed, 1);
  });

  test("移动预算耗尽返回 budget-exhausted 与已采集数据", async () => {
    const adapter = new MemoryVirtualListAdapter(makeRows("r", 20), {
      pageSize: 3,
    });

    const result = await collectVirtualList(adapter, {
      stableRounds: 3,
      moveBudget: 2,
    });

    assert.equal(result.status, "budget-exhausted");
    assert.equal(result.movesUsed, 2);
    assert.ok(result.rows.length > 0);
    assert.ok(result.rows.length < 20);
    assert.match(result.reason, /预算/);
  });

  test("非法参数直接抛 TypeError", async () => {
    const adapter = new MemoryVirtualListAdapter(makeRows("r", 2), {
      pageSize: 2,
    });
    await assert.rejects(
      collectVirtualList(adapter, { stableRounds: 0, moveBudget: 3 }),
      TypeError,
    );
    await assert.rejects(
      collectVirtualList(adapter, { stableRounds: 2, moveBudget: -1 }),
      TypeError,
    );
  });

  test("同 ID 更高版本覆盖旧版且视为进展", async () => {
    const adapter = new MemoryVirtualListAdapter(
      [
        { id: "a", version: 0, content: "v0" },
        { id: "b", version: 0, content: "b" },
        { id: "c", version: 0, content: "c" },
      ],
      {
        pageSize: 3,
        events: [
          {
            type: "upsert-before-read",
            times: 3,
            row: { id: "a", version: 1, content: "v1" },
          },
        ],
      },
    );

    const result = await collectVirtualList(adapter, {
      stableRounds: 2,
      moveBudget: 10,
    });

    assert.equal(result.status, "completed");
    const rowA = result.rows.find((row) => row.id === "a");
    assert.equal(rowA?.version, 1);
    assert.equal(rowA?.content, "v1");
  });

  test("同版本不同内容触发 protocol-error 并停止", async () => {
    const adapter = new MemoryVirtualListAdapter(
      [
        { id: "a", version: 0, content: "原始" },
        { id: "b", version: 0, content: "b" },
      ],
      {
        pageSize: 2,
        events: [
          {
            type: "upsert-before-read",
            times: 2,
            row: { id: "a", version: 0, content: "被篡改" },
          },
        ],
      },
    );

    const result = await collectVirtualList(adapter, {
      stableRounds: 2,
      moveBudget: 10,
    });

    assert.equal(result.status, "protocol-error");
    assert.match(result.reason, /内容不一致/);
  });

  test("首次 read 失败直接 read-failed，返回空采集结果", async () => {
    const adapter = new MemoryVirtualListAdapter(makeRows("r", 3), {
      pageSize: 2,
      events: [{ type: "read-fail", times: 1 }],
    });

    const result = await collectVirtualList(adapter, {
      stableRounds: 2,
      moveBudget: 5,
    });

    assert.equal(result.status, "read-failed");
    assert.equal(result.rows.length, 0);
    assert.equal(result.movesUsed, 0);
  });

  test("采集中途 read 失败：先停止，返回此前已采集数据", async () => {
    const adapter = new MemoryVirtualListAdapter(makeRows("r", 8), {
      pageSize: 3,
      events: [
        // 第 1 次 move 成功后的读取（第 2 次 read）失败。
        { type: "read-fail", times: 2 },
      ],
    });

    const result = await collectVirtualList(adapter, {
      stableRounds: 2,
      moveBudget: 10,
    });

    assert.equal(result.status, "read-failed");
    assert.equal(result.movesUsed, 1);
    assert.ok(result.rows.length >= 3, "首次视口的数据已采集并保留");
  });
});
