import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  makeRows,
  MemoryVirtualListAdapter,
  VirtualListCollector,
  type CollectorPhase,
} from "../index.js";

/** 记录每次 read/move 前后状态机阶段的适配器包装。 */
class PhaseRecordingAdapter extends MemoryVirtualListAdapter {
  readonly phases: CollectorPhase[] = [];
  constructor(
    rows: ReturnType<typeof makeRows>,
    private readonly collector: () => VirtualListCollector,
  ) {
    super(rows, { pageSize: 3 });
  }

  override async read() {
    this.phases.push(this.collector().snapshot().phase);
    return super.read();
  }

  override async move(anchorId: string, delta: number) {
    this.phases.push(this.collector().snapshot().phase);
    return super.move(anchorId, delta);
  }
}

describe("状态机阶段", () => {
  test("采集过程经历 initializing -> moving -> reading-viewport，结束为 finished", async () => {
    let collector!: VirtualListCollector;
    const adapter = new PhaseRecordingAdapter(makeRows("r", 6), () => collector);
    collector = new VirtualListCollector(adapter, {
      stableRounds: 2,
      moveBudget: 20,
    });

    const result = await collector.run();

    assert.equal(result.status, "completed");
    assert.deepEqual(collector.snapshot().phase, "finished");
    // 第一次调用 read 时处于 initializing；之后每次 move 前处于 moving。
    assert.equal(adapter.phases[0], "initializing");
    assert.ok(adapter.phases.includes("moving"));
    // 阶段序列合法：moving 之后只能是 reading-viewport（read 调用）。
    const moveIndexes = adapter.phases
      .map((phase, index) => (phase === "moving" ? index : -1))
      .filter((index) => index >= 0);
    for (const index of moveIndexes) {
      const next = adapter.phases[index + 1];
      assert.ok(next === undefined || next === "reading-viewport");
    }
  });

  test("响应丢失恢复阶段可观测为 recovering", async () => {
    const seen: CollectorPhase[] = [];
    const adapter = new MemoryVirtualListAdapter(makeRows("r", 6), {
      pageSize: 3,
      events: [{ type: "move-lost", times: 1 }],
    });
    const collector = new VirtualListCollector(adapter, {
      stableRounds: 2,
      moveBudget: 20,
    });
    const originalRead = adapter.read.bind(adapter);
    adapter.read = async () => {
      seen.push(collector.snapshot().phase);
      return originalRead();
    };

    const result = await collector.run();

    assert.equal(result.status, "completed");
    // 第 2 次 read 是 move-lost 后的恢复读取，阶段为 recovering。
    assert.equal(seen[1], "recovering");
  });
});
