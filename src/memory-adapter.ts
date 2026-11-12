import type { MoveResult, Row, VirtualListAdapter, Viewport } from "./types.js";

/**
 * 脚本化事件：在第 times 次指定调用发生时触发（times 从 1 开始）。
 * 事件在该次调用的核心逻辑前后按规则生效，用于模拟宿主侧的异步变化。
 */
export type ScriptedEvent =
  /** 第 times 次 read() reject，不改变列表状态。 */
  | { type: "read-fail"; times: number; error?: Error }
  /**
   * 第 times 次 move() 先正常滚动并推进代数，再 reject，
   * 模拟“动作成功但响应丢失”。
   */
  | { type: "move-lost"; times: number; error?: Error }
  /** 第 times 次 move() 在滚动之前 reject，列表与代数保持不变。 */
  | { type: "move-fail"; times: number; error?: Error }
  /** 第 times 次 read() 之前删除指定行，并推进代数。 */
  | { type: "delete-before-read"; times: number; id: string }
  /** 第 times 次 move() 之前删除指定行（使其成为 stale 锚点），并推进代数。 */
  | { type: "delete-before-move"; times: number; id: string }
  /** 第 times 次 read() 之前重排（把 id 移动到目标下标），并推进代数。 */
  | { type: "reorder-before-read"; times: number; id: string; toIndex: number }
  /** 第 times 次 read() 之前写入行（新增或高版本覆盖），并推进代数。 */
  | { type: "upsert-before-read"; times: number; row: Row };

export interface MemoryAdapterOptions {
  /** 视口容量（行数）。 */
  readonly pageSize: number;
  /** 脚本化事件，按 times 匹配；同一时刻最多一个事件生效。 */
  readonly events?: readonly ScriptedEvent[];
}

/**
 * 内存虚拟列表适配器，作为浏览器宿主的确定性测试替身。
 *
 * 不变量（与真实适配器协议一致）：
 * - 同一代数内 read() 返回完全相同的视口；
 * - 任何列表状态变化（滚动、删除、重排、upsert）都推进代数；
 * - 锚点已被删除时 move() 返回 stale 且不移动、不推进代数；
 * - move-lost 先改状态再 reject，采集器只能靠 read() 确认代数。
 */
export class MemoryVirtualListAdapter implements VirtualListAdapter {
  private rows: Row[];
  private readonly pageSize: number;
  private readonly events: readonly ScriptedEvent[];

  private offset = 0;
  private generation = 0;
  private readCalls = 0;
  private moveCalls = 0;
  private staleCount = 0;

  constructor(initialRows: readonly Row[], options: MemoryAdapterOptions) {
    if (!Number.isInteger(options.pageSize) || options.pageSize <= 0) {
      throw new TypeError("pageSize 必须是正整数");
    }
    this.rows = [...initialRows];
    this.pageSize = options.pageSize;
    this.events = options.events ?? [];
  }

  /** 当前代数（测试断言用）。 */
  currentGeneration(): number {
    return this.generation;
  }

  /** read 调用次数（测试断言用）。 */
  readCallCount(): number {
    return this.readCalls;
  }

  /** move 调用次数（测试断言用）。 */
  moveCallCount(): number {
    return this.moveCalls;
  }

  /** 返回 stale 的 move 次数（测试断言用）。 */
  staleMoveCount(): number {
    return this.staleCount;
  }

  /** 当前列表剩余行数（测试断言用）。 */
  rowCount(): number {
    return this.rows.length;
  }

  /** 测试辅助：直接删除一行并推进代数。 */
  deleteRow(id: string): void {
    const index = this.rows.findIndex((row) => row.id === id);
    if (index === -1) {
      return;
    }
    this.rows.splice(index, 1);
    this.generation += 1;
  }

  /** 测试辅助：新增行，或以更高版本覆盖同 ID 行，并推进代数。 */
  upsertRow(row: Row): void {
    const index = this.rows.findIndex((existing) => existing.id === row.id);
    if (index === -1) {
      this.rows.push(row);
    } else {
      this.rows[index] = row;
    }
    this.generation += 1;
  }

  async read(): Promise<Viewport> {
    this.readCalls += 1;
    this.runReadEvents(this.readCalls);
    const fail = this.takeEvent("read-fail", this.readCalls);
    if (fail) {
      throw fail.error ?? new Error("脚本化 read 失败");
    }
    return this.snapshot();
  }

  async move(anchorId: string, delta: number): Promise<MoveResult> {
    this.moveCalls += 1;
    const times = this.moveCalls;

    for (const event of this.events) {
      if (event.times === times && event.type === "delete-before-move") {
        this.deleteRow(event.id);
      }
    }

    const earlyFail = this.takeEvent("move-fail", times);
    if (earlyFail) {
      throw earlyFail.error ?? new Error("脚本化 move 失败");
    }

    const anchorIndex = this.rows.findIndex((row) => row.id === anchorId);
    if (anchorIndex === -1) {
      // 锚点已被移除：不移动、不推进代数。
      this.staleCount += 1;
      return { kind: "stale", generation: this.generation };
    }
    if (delta !== 1) {
      throw new Error(`测试替身仅支持 delta=1，收到 ${String(delta)}`);
    }

    // 正常滚动：锚点之后至少还有一行时视口前移一行。
    const maxOffset = Math.max(0, this.rows.length - this.pageSize);
    this.offset = Math.min(this.offset + 1, maxOffset);
    this.generation += 1;

    const lost = this.takeEvent("move-lost", times);
    if (lost) {
      // 状态已变更、代数已推进，但响应丢失。
      throw lost.error ?? new Error("脚本化 move 响应丢失");
    }

    return { kind: "moved", generation: this.generation };
  }

  private runReadEvents(times: number): void {
    for (const event of this.events) {
      if (event.times !== times) {
        continue;
      }
      if (event.type === "delete-before-read") {
        this.deleteRow(event.id);
      } else if (event.type === "delete-before-move") {
        // move 事件在 move() 内处理，read 阶段忽略。
        continue;
      } else if (event.type === "reorder-before-read") {
        this.reorder(event.id, event.toIndex);
      } else if (event.type === "upsert-before-read") {
        this.upsertRow(event.row);
      }
    }
  }

  private takeEvent(
    type: "read-fail" | "move-lost" | "move-fail",
    times: number,
  ): Extract<ScriptedEvent, { error?: Error; type: typeof type }> | undefined {
    return this.events.find(
      (event): event is Extract<ScriptedEvent, { error?: Error; type: typeof type }> =>
        event.type === type && event.times === times,
    );
  }

  private reorder(id: string, toIndex: number): void {
    const fromIndex = this.rows.findIndex((row) => row.id === id);
    if (fromIndex === -1) {
      return;
    }
    const [row] = this.rows.splice(fromIndex, 1);
    if (row === undefined) {
      return;
    }
    const boundedIndex = Math.max(0, Math.min(toIndex, this.rows.length));
    this.rows.splice(boundedIndex, 0, row);
    this.generation += 1;
  }

  private snapshot(): Viewport {
    const visible = this.rows.slice(this.offset, this.offset + this.pageSize);
    return {
      rows: visible.map((row) => ({ ...row })),
      generation: this.generation,
    };
  }
}

/** 构造连续 id（id-0..id-n-1）、版本 0 的测试行。 */
export function makeRows(prefix: string, count: number): Row[] {
  const rows: Row[] = [];
  for (let index = 0; index < count; index += 1) {
    rows.push({ id: `${prefix}-${index}`, version: 0, content: `内容 ${index}` });
  }
  return rows;
}
