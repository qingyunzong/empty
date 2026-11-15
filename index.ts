/**
 * 虚拟表格滚动加载采集协调器。
 *
 * 面向浏览器 RPA：虚拟列表会复用 DOM 节点，因此采集以业务行键为准，
 * DOM 节点复用（同一节点先后渲染不同行、或同一行出现在不同节点）不计为新行。
 * 排序 / 筛选变化体现为世代（generation）变化，此时未闭合的轮次被整体废弃。
 * 完成条件：达到预期总数，或连续若干个观察窗口无任何新行与版本变化。
 */

export type RowKey = string;
export type Generation = string | number;

/** 视窗锚点：定位一次观察窗口在滚动序列中的位置。 */
export interface ViewportAnchor {
  /** 窗口首行的业务行键（若可读取）。 */
  firstKey?: RowKey;
  /** 窗口首行的绝对行号（若可读取）。 */
  firstIndex?: number;
  /** 滚动容器 scrollTop。 */
  scrollTop?: number;
}

export interface RowSnapshot {
  /** 业务行键，采集去重的唯一依据。 */
  key: RowKey;
  /** 数据版本（如行哈希 / 修订号），变化视为行被更新。 */
  version: string;
  /** 绝对行号（若可知），用于缺口计算。 */
  index?: number;
  /** 渲染该行的 DOM 节点标识，仅用于诊断，不参与计数。 */
  nodeId?: string;
  /** 行数据负载。 */
  data?: unknown;
}

export interface WindowObservation {
  anchor: ViewportAnchor;
  rows: RowSnapshot[];
}

export interface CollectorOptions {
  /** 预期总行数；采集到该数量的唯一行键即完成。 */
  expectedTotal?: number;
  /** 连续稳定窗口数达到该值即完成，默认 3。 */
  stableWindowsToComplete?: number;
}

export interface ObserveResult {
  /** 本轮首次出现的行键。 */
  newKeys: RowKey[];
  /** 已存在但版本变化的行键。 */
  updatedKeys: RowKey[];
  /** 已采集过的行键（含 DOM 复用导致的重复出现）。 */
  reusedKeys: RowKey[];
  /** 当前连续稳定窗口计数（本窗口稳定则递增，否则归零）。 */
  stableStreak: number;
}

export interface GapRange {
  /** 缺口起始行号（含）。 */
  start: number;
  /** 缺口结束行号（含）。 */
  end: number;
  count: number;
}

export type CompletionReason = "expected-total" | "stable-windows";

export interface CollectionStatus {
  generation: Generation | null;
  roundOpen: boolean;
  /** 已提交 + 当前轮次缓冲中的唯一行键数。 */
  collected: number;
  complete: boolean;
  completionReason: CompletionReason | null;
  stableStreak: number;
  gaps: GapRange[];
  /** 因世代变化被废弃的未闭合轮次数。 */
  discardedRounds: number;
}

export interface CollectedRow {
  key: RowKey;
  version: string;
  index?: number;
  data?: unknown;
}

export interface CollectionResult {
  complete: boolean;
  completionReason: CompletionReason | null;
  rows: CollectedRow[];
  gaps: GapRange[];
}

interface StoredRow {
  version: string;
  index?: number;
  data?: unknown;
}

interface RoundState {
  generation: Generation;
  pending: Map<RowKey, StoredRow>;
  observations: number;
}

const DEFAULT_STABLE_WINDOWS = 3;

export class VirtualTableCollector {
  private readonly expectedTotal?: number;
  private readonly stableWindowsToComplete: number;

  private committed = new Map<RowKey, StoredRow>();
  private round: RoundState | null = null;
  private currentGeneration: Generation | null = null;
  private stableStreak = 0;
  private discardedRoundCount = 0;
  private completed: CompletionReason | null = null;

  constructor(options: CollectorOptions = {}) {
    this.expectedTotal = options.expectedTotal;
    this.stableWindowsToComplete =
      options.stableWindowsToComplete ?? DEFAULT_STABLE_WINDOWS;
  }

  /**
   * 开启一个采集轮次。世代与当前不一致时，废弃未闭合的旧轮次。
   * 已有未闭合轮次且世代相同则抛错，避免嵌套轮次。
   */
  beginRound(generation: Generation): void {
    if (this.round) {
      if (this.round.generation === generation) {
        throw new Error("上一轮次尚未闭合");
      }
      this.discardOpenRound();
    }
    if (this.currentGeneration !== generation) {
      this.currentGeneration = generation;
      this.stableStreak = 0;
      this.completed = null;
    }
    this.round = { generation, pending: new Map(), observations: 0 };
  }

  /**
   * 录入一个视窗观察。若当前没有开启的轮次，则以给定世代隐式开启；
   * 世代变化时自动废弃未闭合轮次并以新世代开轮。
   */
  observe(observation: WindowObservation, generation: Generation): ObserveResult {
    if (!this.round || this.round.generation !== generation) {
      if (this.round) this.discardOpenRound();
      this.beginRound(generation);
    }
    const round = this.round!;
    round.observations += 1;

    const newKeys: RowKey[] = [];
    const updatedKeys: RowKey[] = [];
    const reusedKeys: RowKey[] = [];

    for (const row of observation.rows) {
      const pendingHit = round.pending.get(row.key);
      const committedHit = this.committed.get(row.key);
      const existing = pendingHit ?? committedHit;

      if (!existing) {
        newKeys.push(row.key);
        round.pending.set(row.key, {
          version: row.version,
          index: row.index,
          data: row.data,
        });
        continue;
      }
      if (existing.version !== row.version) {
        updatedKeys.push(row.key);
        // 版本变化以最新观察为准；已提交行的更新也暂存在本轮缓冲，随闭轮提交。
        round.pending.set(row.key, {
          version: row.version,
          index: row.index ?? existing.index,
          data: row.data,
        });
        continue;
      }
      // 同键同版本：DOM 节点复用或窗口重叠，不计为新行。
      reusedKeys.push(row.key);
      if (existing.index === undefined && row.index !== undefined) {
        round.pending.set(row.key, { ...existing, index: row.index });
      }
    }

    const stable = newKeys.length === 0 && updatedKeys.length === 0;
    this.stableStreak = stable ? this.stableStreak + 1 : 0;
    this.evaluateCompletion();

    return { newKeys, updatedKeys, reusedKeys, stableStreak: this.stableStreak };
  }

  /** 闭合当前轮次，把缓冲的观察提交进已确认集合。 */
  closeRound(): void {
    if (!this.round) throw new Error("没有开启的轮次");
    for (const [key, row] of this.round.pending) {
      this.committed.set(key, row);
    }
    this.round = null;
    this.evaluateCompletion();
  }

  /** 主动废弃当前未闭合轮次（如检测到排序 / 筛选交互但世代号未变）。 */
  abortRound(): void {
    if (this.round) this.discardOpenRound();
  }

  status(): CollectionStatus {
    return {
      generation: this.currentGeneration,
      roundOpen: this.round !== null,
      collected: this.mergedRows().size,
      complete: this.completed !== null,
      completionReason: this.completed,
      stableStreak: this.stableStreak,
      gaps: this.computeGaps(),
      discardedRounds: this.discardedRoundCount,
    };
  }

  /** 汇总采集结果。行按绝对行号（缺失行号排后，按键名字典序）排序输出。 */
  result(): CollectionResult {
    const merged = this.mergedRows();
    const rows: CollectedRow[] = [...merged.entries()].map(([key, row]) => ({
      key,
      version: row.version,
      index: row.index,
      data: row.data,
    }));
    rows.sort((a, b) => {
      if (a.index !== undefined && b.index !== undefined) return a.index - b.index;
      if (a.index !== undefined) return -1;
      if (b.index !== undefined) return 1;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
    return {
      complete: this.completed !== null,
      completionReason: this.completed,
      rows,
      gaps: this.computeGaps(),
    };
  }

  private discardOpenRound(): void {
    this.round = null;
    this.discardedRoundCount += 1;
    this.stableStreak = 0;
  }

  private mergedRows(): Map<RowKey, StoredRow> {
    const merged = new Map(this.committed);
    if (this.round) {
      for (const [key, row] of this.round.pending) merged.set(key, row);
    }
    return merged;
  }

  private evaluateCompletion(): void {
    if (this.completed) return;
    const collected = this.mergedRows().size;
    if (this.expectedTotal !== undefined && collected >= this.expectedTotal) {
      this.completed = "expected-total";
      return;
    }
    if (this.stableStreak >= this.stableWindowsToComplete) {
      this.completed = "stable-windows";
    }
  }

  /**
   * 缺口：在 [0, 上界] 内缺失的绝对行号区间。
   * 上界取已知最大行号与 expectedTotal - 1 的较大者；无任何行号信息时为空。
   */
  private computeGaps(): GapRange[] {
    const merged = this.mergedRows();
    const present = new Set<number>();
    let maxIndex = -1;
    for (const row of merged.values()) {
      if (row.index === undefined) continue;
      present.add(row.index);
      if (row.index > maxIndex) maxIndex = row.index;
    }
    const upper = Math.max(
      maxIndex,
      this.expectedTotal !== undefined ? this.expectedTotal - 1 : -1,
    );
    if (upper < 0) return [];

    const gaps: GapRange[] = [];
    let start = -1;
    for (let i = 0; i <= upper; i += 1) {
      if (!present.has(i)) {
        if (start < 0) start = i;
      } else if (start >= 0) {
        gaps.push({ start, end: i - 1, count: i - start });
        start = -1;
      }
    }
    if (start >= 0) gaps.push({ start, end: upper, count: upper - start + 1 });
    return gaps;
  }
}

export function createCollector(options: CollectorOptions = {}): VirtualTableCollector {
  return new VirtualTableCollector(options);
}
