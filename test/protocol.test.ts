import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  MoveResult,
  Row,
  Viewport,
  VirtualListAdapter,
} from "../index.js";
import { collectVirtualList, makeRows } from "../index.js";

/** 可脚本化代数/视口行为的最小适配器，用于协议违例测试。 */
class ScriptedAdapter implements VirtualListAdapter {
  private generation = 0;
  rows: Row[];
  private readPlan: Array<() => Viewport> = [];
  private movePlan: Array<() => MoveResult> = [];

  constructor(rows: Row[]) {
    this.rows = rows;
  }

  queueRead(viewport: () => Viewport): this {
    this.readPlan.push(viewport);
    return this;
  }

  queueMove(outcome: () => MoveResult): this {
    this.movePlan.push(outcome);
    return this;
  }

  async read(): Promise<Viewport> {
    const planned = this.readPlan.shift();
    if (planned) {
      return planned();
    }
    return { rows: this.rows.map((row) => ({ ...row })), generation: this.generation };
  }

  async move(anchorId: string, delta: number): Promise<MoveResult> {
    assert.equal(anchorId, this.rows[this.rows.length - 1]?.id);
    assert.equal(delta, 1);
    const planned = this.movePlan.shift();
    if (planned) {
      const outcome = planned();
      if (outcome.kind === "moved") {
        this.generation = outcome.generation;
      }
      return outcome;
    }
    this.generation += 1;
    return { kind: "moved", generation: this.generation };
  }
}

describe("协议违例", () => {
  test("read 返回回退代数时以 protocol-error 停止", async () => {
    const adapter = new ScriptedAdapter(makeRows("r", 3));
    adapter.queueRead(() => ({
      rows: makeRows("r", 3),
      generation: 0,
    }));
    adapter.queueMove(() => ({ kind: "moved", generation: 1 }));
    adapter.queueRead(() => ({
      rows: makeRows("r", 3),
      generation: 0,
    }));

    const result = await collectVirtualList(adapter, {
      stableRounds: 1,
      moveBudget: 5,
    });

    assert.equal(result.status, "protocol-error");
    assert.match(result.reason, /回退/);
  });

  test("move 返回未递增代数时以 protocol-error 停止", async () => {
    const adapter = new ScriptedAdapter(makeRows("r", 3));
    adapter.queueMove(() => ({ kind: "moved", generation: 0 }));

    const result = await collectVirtualList(adapter, {
      stableRounds: 1,
      moveBudget: 5,
    });

    assert.equal(result.status, "protocol-error");
    assert.match(result.reason, /未递增/);
  });

  test("move 丢失后恢复读取到回退代数：protocol-error", async () => {
    const rows = makeRows("r", 3);
    const adapter = new ScriptedAdapter(rows);
    // 先正常移动一次，确认代数推进到 1。
    adapter.queueRead(() => ({ rows, generation: 1 }));
    // 第二次 move 响应丢失。
    adapter.queueMove(() => {
      throw new Error("响应丢失");
    });
    // 恢复读取却看到比已确认代数更旧的值。
    adapter.queueRead(() => ({ rows, generation: 0 }));

    const result = await collectVirtualList(adapter, {
      stableRounds: 1,
      moveBudget: 5,
    });

    assert.equal(result.status, "protocol-error");
    assert.match(result.reason, /代数回退/);
  });

  test("空视口无法取锚点时以 protocol-error 停止", async () => {
    const adapter = new ScriptedAdapter([]);

    const result = await collectVirtualList(adapter, {
      stableRounds: 1,
      moveBudget: 5,
    });

    assert.equal(result.status, "protocol-error");
    assert.match(result.reason, /视口为空/);
  });
});

describe("K 轮边界", () => {
  test("更高版本出现会重置稳定计数，需要重新累计 K 轮", async () => {
    const rows: Row[] = [
      { id: "a", version: 0, content: "a0" },
      { id: "b", version: 0, content: "b0" },
    ];
    const adapter = new ScriptedAdapter(rows);
    adapter.queueRead(() => ({ rows: rows.map((row) => ({ ...row })), generation: 0 }));
    // 第 1 次有效移动（代数 0 -> 1）后的读取：无进展（稳定计数 1/K=2）。
    adapter.queueMove(() => ({ kind: "moved", generation: 1 }));
    adapter.queueRead(() => ({
      rows: [
        { id: "a", version: 0, content: "a0" },
        { id: "b", version: 0, content: "b0" },
      ],
      generation: 1,
    }));
    // 第 2 次有效移动（代数 1 -> 2）后的读取：a 升级，有进展，计数清零。
    adapter.queueMove(() => ({ kind: "moved", generation: 2 }));
    adapter.queueRead(() => ({
      rows: [
        { id: "a", version: 1, content: "a1" },
        { id: "b", version: 0, content: "b0" },
      ],
      generation: 2,
    }));
    // 之后默认 move 让代数继续 3、4、5...，默认 read 回传升级后的行。
    adapter.rows = [
      { id: "a", version: 1, content: "a1" },
      { id: "b", version: 0, content: "b0" },
    ];

    const result = await collectVirtualList(adapter, {
      stableRounds: 2,
      moveBudget: 10,
    });

    assert.equal(result.status, "completed");
    // 无进展(1) -> 升级清零 -> 无进展(1) -> 无进展(2) 才结束，共 4 次移动。
    assert.ok(result.movesUsed >= 4);
    const rowA = result.rows.find((row) => row.id === "a");
    assert.equal(rowA?.version, 1);
  });
});
