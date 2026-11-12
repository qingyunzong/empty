import type {
  CollectOptions,
  CollectResult,
  CollectStatus,
  Row,
  VirtualListAdapter,
  Viewport,
} from "./types.js";
import { ProtocolError } from "./types.js";

/**
 * 采集器内部状态机的阶段。
 *
 * 状态迁移：
 *
 *   Initializing
 *     --read() 成功--> ReadingViewport（合并视口）
 *     --read() 失败--> Failed("read-failed")
 *
 *   ReadingViewport --合并完成--> ReadyToMove
 *
 *   ReadyToMove
 *     --预算耗尽--> Finished("budget-exhausted")
 *     --连续 K 轮无新增--> Finished("completed")
 *     --以最后一行为锚点 move()--> Moving
 *
 *   Moving
 *     --moved(gen 递增)---------------> ReadingViewport（读新视口）
 *     --stale（锚点被移除，未滚动）----> ReadingViewport（重新 read，不计轮次）
 *     --reject（响应可能丢失）--------> Recovering
 *
 *   Recovering
 *     --read() 失败-------------------> Failed("read-failed")
 *     --代数增加：确认 move 已生效----> ReadingViewport（读新视口，不重试 move）
 *     --代数未变：move 未生效---------> ReadyToMove（重试同一移动）
 *     --read() 再次失败---------------> Failed
 *
 * 任何阶段检测到协议违例（代数非递增、同版本内容冲突等）立即进入
 * Failed("protocol-error")。
 */
export type CollectorPhase =
  | "initializing"
  | "reading-viewport"
  | "ready-to-move"
  | "moving"
  | "recovering"
  | "finished";

interface Snapshot {
  readonly phase: CollectorPhase;
  readonly generation: number;
  readonly movesUsed: number;
  readonly stableRounds: number;
  readonly collectedCount: number;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} 必须是正整数，实际收到: ${String(value)}`);
  }
}

/**
 * 状态机驱动的虚拟列表采集器。
 *
 * 用法：
 *   const result = await new VirtualListCollector(adapter, options).run();
 */
export class VirtualListCollector {
  private readonly adapter: VirtualListAdapter;
  private readonly stableRounds: number;
  private readonly moveBudget: number;

  /** 已采集行：id -> 行（同 ID 只保留最高版本）。 */
  private readonly collected = new Map<string, Row>();
  /** 已采集行的首次出现顺序。 */
  private readonly order: string[] = [];

  private phase: CollectorPhase = "initializing";
  private generation = -1;
  private movesUsed = 0;
  /** 连续“有效移动后无新增（新 ID 或更高版本）”的轮数。 */
  private stableRoundsSeen = 0;

  constructor(adapter: VirtualListAdapter, options: CollectOptions) {
    positiveInteger(options.stableRounds, "stableRounds");
    positiveInteger(options.moveBudget, "moveBudget");
    this.adapter = adapter;
    this.stableRounds = options.stableRounds;
    this.moveBudget = options.moveBudget;
  }

  /** 当前状态机快照，主要用于测试与宿主侧可观测性。 */
  snapshot(): Snapshot {
    return {
      phase: this.phase,
      generation: this.generation,
      movesUsed: this.movesUsed,
      stableRounds: this.stableRoundsSeen,
      collectedCount: this.collected.size,
    };
  }

  async run(): Promise<CollectResult> {
    try {
      return await this.loop();
    } catch (error) {
      if (error instanceof ProtocolError) {
        this.phase = "finished";
        return this.result("protocol-error", error.message);
      }
      if (error instanceof CollectStop) {
        this.phase = "finished";
        return this.result(error.status, error.message);
      }
      throw error;
    }
  }

  private async loop(): Promise<CollectResult> {
    // Initializing -> ReadingViewport：首次 read 失败必须直接停止。
    let viewport = await this.readViewport(true);
    // 只有“有效移动（moved 或 move-lost 经 read 确认代数增加）之后”的
    // 视口才参与连续 K 轮判定；初次读取与 stale 重读都不计入。
    let effectiveMove = false;

    while (true) {
      // ReadingViewport：合并视口；初次读取与 stale 重读都不计入稳定轮次，
      // 只有“有效移动之后”的读取才参与 K 轮判定。
      const madeProgress = this.merge(viewport);

      // ReadyToMove：先判终止，再发起移动。
      if (effectiveMove) {
        if (madeProgress) {
          this.stableRoundsSeen = 0;
        } else {
          this.stableRoundsSeen += 1;
        }
      }
      effectiveMove = false;
      this.phase = "ready-to-move";

      if (this.stableRoundsSeen >= this.stableRounds) {
        return this.result(
          "completed",
          `连续 ${this.stableRounds} 次有效移动未发现新 ID 或更高版本`,
        );
      }
      if (this.movesUsed >= this.moveBudget) {
        return this.result(
          "budget-exhausted",
          `移动预算 ${this.moveBudget} 已耗尽`,
        );
      }

      const anchor = this.lastRowOf(viewport);

      // Moving：以当前视口最后一行为锚点、delta 固定为 1。
      this.phase = "moving";
      this.movesUsed += 1;
      let moveOutcome: Awaited<ReturnType<VirtualListAdapter["move"]>>;
      try {
        moveOutcome = await this.adapter.move(anchor.id, 1);
      } catch {
        // Recovering：响应可能在 move 成功之后才丢失，read 确认代数。
        const confirmed = await this.recoverAfterLostResponse();
        if (confirmed === undefined) {
          // 代数未变，move 未生效：回到 ReadyToMove 重试同一移动。
          this.phase = "ready-to-move";
          continue;
        }
        viewport = confirmed;
        effectiveMove = true;
        this.phase = "reading-viewport";
        continue;
      }

      if (moveOutcome.kind === "stale") {
        // 锚点已被移除，适配器未滚动；删除动作本身可能已推进代数，
        // 因此 stale 只要求代数不回退，真实代数以下一次 read 为准。
        this.expectNotLowerGeneration(moveOutcome.generation, "move(stale)");
        this.generation = moveOutcome.generation;
        // 重新 read 后再试；stale 不是有效移动，不计稳定轮次。
        this.phase = "reading-viewport";
        viewport = await this.readViewport(false);
        continue;
      }

      // moved：只接受严格递增的代数，然后只能 read 新视口，不得重复滚动。
      this.expectHigherGeneration(moveOutcome.generation, "move(moved)");
      this.generation = moveOutcome.generation;
      this.phase = "reading-viewport";
      viewport = await this.readViewport(false);
      effectiveMove = true;
    }
  }

  /**
   * 读取视口。initialRead 为 true 时处于 Initializing，
   * 否则处于 ReadingViewport。read 失败一律先停止。
   */
  private async readViewport(initialRead: boolean): Promise<Viewport> {
    this.phase = initialRead ? "initializing" : "reading-viewport";
    let viewport: Viewport;
    try {
      viewport = await this.adapter.read();
    } catch (error) {
      this.phase = "finished";
      throw new CollectStop("read-failed", describeError("read() 失败", error));
    }
    if (this.generation === -1) {
      this.expectNonNegativeGeneration(viewport.generation);
      this.generation = viewport.generation;
    } else {
      // 同一代数内 read 结果不变（幂等重读）；只接受代数持平或递增。
      this.expectNotLowerGeneration(viewport.generation, "read()");
      this.generation = viewport.generation;
    }
    return viewport;
  }

  /**
   * move 响应丢失后的恢复。
   *
   * - read 失败：按协议先停止（read-failed）。
   * - 代数增加：move 实际已生效，返回新视口；调用方不得重复滚动。
   * - 代数未变：move 未生效，返回 undefined，调用方可重试同一移动。
   */
  private async recoverAfterLostResponse(): Promise<Viewport | undefined> {
    this.phase = "recovering";
    let viewport: Viewport;
    try {
      viewport = await this.adapter.read();
    } catch (readError) {
      this.phase = "finished";
      throw new CollectStop(
        "read-failed",
        describeError("move 响应丢失后 read() 也失败", readError),
      );
    }
    if (viewport.generation > this.generation) {
      this.generation = viewport.generation;
      return viewport;
    }
    if (viewport.generation < this.generation) {
      throw new ProtocolError(
        `恢复读取时代数回退: 已确认 ${this.generation}，读取到 ${viewport.generation}`,
      );
    }
    // 代数持平 => move 没有生效，允许重试。
    return undefined;
  }

  /**
   * 将视口行合并进已采集数据。
   *
   * - 新 ID：记录，视为有进展。
   * - 同 ID 更高版本：覆盖旧内容，视为有进展。
   * - 同 ID 同版本同内容：无变化。
   * - 同 ID 同版本不同内容：协议错误。
   * - 同 ID 更低版本：忽略（保留已采集的较高版本）。
   *
   * @returns 本次视口是否带来新 ID 或更高版本。
   */
  private merge(viewport: Viewport): boolean {
    let madeProgress = false;
    for (const row of viewport.rows) {
      if (!Number.isInteger(row.version) || row.version < 0) {
        throw new ProtocolError(
          `行 ${row.id} 的版本必须是非负整数，实际为: ${String(row.version)}`,
        );
      }
      const existing = this.collected.get(row.id);
      if (existing === undefined) {
        this.collected.set(row.id, row);
        this.order.push(row.id);
        madeProgress = true;
      } else if (row.version > existing.version) {
        this.collected.set(row.id, row);
        madeProgress = true;
      } else if (row.version === existing.version && row.content !== existing.content) {
        throw new ProtocolError(
          `行 ${row.id} 版本 ${row.version} 相同但内容不一致`,
        );
      }
    }
    return madeProgress;
  }

  private lastRowOf(viewport: Viewport): Row {
    const last = viewport.rows[viewport.rows.length - 1];
    if (last === undefined) {
      throw new ProtocolError("视口为空，无法取最后一行作为 move 锚点");
    }
    return last;
  }

  private expectNonNegativeGeneration(generation: number): void {
    if (!Number.isInteger(generation) || generation < 0) {
      throw new ProtocolError(`滚动代数必须是非负整数，实际为: ${String(generation)}`);
    }
  }

  private expectHigherGeneration(generation: number, source: string): void {
    if (!Number.isInteger(generation) || generation <= this.generation) {
      throw new ProtocolError(
        `${source} 返回的代数未递增: 已确认 ${this.generation}，收到 ${String(generation)}`,
      );
    }
  }

  private expectNotLowerGeneration(generation: number, source: string): void {
    if (!Number.isInteger(generation) || generation < this.generation) {
      throw new ProtocolError(
        `${source} 返回的代数回退: 已确认 ${this.generation}，收到 ${String(generation)}`,
      );
    }
  }

  private result(status: CollectStatus, reason: string): CollectResult {
    this.phase = "finished";
    return {
      status,
      rows: this.order.map((id) => {
        const row = this.collected.get(id);
        if (row === undefined) {
          throw new Error(`内部错误: 已采集顺序中缺少 ${id}`);
        }
        return row;
      }),
      generation: this.generation,
      movesUsed: this.movesUsed,
      reason,
    };
  }
}

/** 内部控制流：read/move 失败导致的确定性终止。 */
class CollectStop extends Error {
  readonly status: CollectStatus;
  constructor(status: CollectStatus, message: string) {
    super(message);
    this.name = "CollectStop";
    this.status = status;
  }
}

function describeError(prefix: string, error: unknown): string {
  if (error instanceof Error) {
    return `${prefix}: ${error.message}`;
  }
  return `${prefix}: ${String(error)}`;
}

/**
 * 便捷入口：驱动适配器采集虚拟列表。
 *
 * 读取失败、协议违例等终止情况都不会向上抛出，而是以对应 status 返回；
 * 仅参数非法（非正整数）时抛出 TypeError。
 */
export async function collectVirtualList(
  adapter: VirtualListAdapter,
  options: CollectOptions,
): Promise<CollectResult> {
  return new VirtualListCollector(adapter, options).run();
}
