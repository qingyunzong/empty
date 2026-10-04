import type { TraceLog } from "./trace.js";

export class CommitError extends Error {
  constructor() {
    super("simulated commit failure");
    this.name = "CommitError";
  }
}

/**
 * 处理端的事务型去重存储：业务效果与“消息 ID 已处理”标记在同一事务里原子提交。
 * 注入提交故障时整体回滚——效果与标记都不落盘，消息等待重投后重新处理。
 */
export class DedupStore {
  private readonly effects: string[] = [];
  private readonly processedIds = new Set<string>();
  private pendingFailures = 0;

  constructor(private readonly trace: TraceLog) {}

  /** 故障注入：接下来 times 次事务提交失败并回滚。 */
  injectCommitFailure(times = 1): void {
    this.pendingFailures += times;
  }

  has(id: string): boolean {
    return this.processedIds.has(id);
  }

  applyEffect(id: string, effect: string): void {
    this.trace.record("store", "tx-begin", { id, effect });
    if (this.pendingFailures > 0) {
      this.pendingFailures -= 1;
      this.trace.record("store", "tx-rollback", { id, reason: "injected-commit-failure" });
      throw new CommitError();
    }
    this.effects.push(effect);
    this.processedIds.add(id);
    this.trace.record("store", "tx-commit", { id, effect });
  }

  effectLog(): readonly string[] {
    return this.effects;
  }

  effectCount(): number {
    return this.effects.length;
  }
}
