export type BusinessKey = string | number;

export interface VisibleEntry<K extends BusinessKey = BusinessKey> {
  /** 稳定业务键，用于去重。 */
  key: K;
  /** 条目在列表中的逻辑序号（若调用方已知）。 */
  index?: number;
  /** 条目起点的滚动偏移（若调用方已知）。 */
  offset?: number;
}

export interface ScrollRange {
  /** 当前滚动偏移（px）。 */
  offset: number;
  /** 可视视口高度（px）。 */
  viewportSize: number;
  /** 内容总高度（若调用方可知）。 */
  totalSize?: number;
}

export interface LayoutEvent {
  /** 容器高度变化后的新高度（px）。 */
  containerHeight: number;
  /** 布局事件附带的最新内容总高度（若有）。 */
  totalSize?: number;
}

export interface CollectorBudget {
  /** 公开预算：允许规划的最大滚动步数。 */
  maxSteps: number;
  /** 公开预算：允许保存的最大业务键数量。 */
  maxKeys?: number;
}

export interface CollectorOptions<K extends BusinessKey = BusinessKey> {
  budget: CollectorBudget;
  /** 连续多少步没有新键即判定“已证明无新键”，默认 3。 */
  loopThreshold?: number;
  /** 相邻两次滚动之间的视口重叠比例，默认 0.15。 */
  overlapRatio?: number;
  /** 自定义业务键提取，默认取 entry.key。 */
  keyOf?: (entry: VisibleEntry<K>) => K;
}

export type DoneReason = 'exhausted' | 'budget';

export interface IngestReport {
  accepted: boolean;
  newKeys: number;
  duplicateKeys: number;
  /** 本次观察到的动态插入事件数（已覆盖区间内出现新键或键位漂移）。 */
  insertions: number;
  /** 是否检测到滚动循环（相同可见签名重复出现且没有新键）。 */
  loopDetected: boolean;
}

export interface CollectorStatus {
  done: boolean;
  reason: DoneReason | null;
  keys: number;
  stepsUsed: number;
  remainingSteps: number;
  insertions: number;
  loops: number;
  coverage: ReadonlyArray<readonly [number, number]>;
}

interface KeyMeta {
  index?: number;
  offset?: number;
}

/**
 * 后台页面采集器：直接接入 TypeScript 虚拟列表遍历组件。
 *
 * 采集器本身不触碰 DOM，只消费调用方提供的可见条目、滚动范围与布局事件：
 * - 调用方每次滚动后调用 `ingest(visible, range)`；
 * - 容器尺寸变化时调用 `onLayout(event)`，采集器会基于已保存的覆盖区间重新规划；
 * - 调用 `nextTarget()` 获取下一个建议滚动偏移，返回 null 表示结束
 *   （已证明无新键，或公开预算耗尽）。
 */
export class VirtualListCollector<K extends BusinessKey = BusinessKey> {
  private readonly budget: CollectorBudget;
  private readonly loopThreshold: number;
  private readonly overlapRatio: number;
  private readonly keyOf: (entry: VisibleEntry<K>) => K;

  private readonly seen = new Map<K, KeyMeta>();
  private readonly signatures = new Set<string>();
  private covered: Array<[number, number]> = [];

  private viewportSize = 0;
  private totalSize: number | undefined;
  private stepsUsed = 0;
  private fruitless = 0;
  private insertions = 0;
  private loops = 0;
  private doneReason: DoneReason | null = null;

  constructor(options: CollectorOptions<K>) {
    if (options.budget.maxSteps < 0) {
      throw new RangeError('budget.maxSteps must be >= 0');
    }
    this.budget = { ...options.budget };
    this.loopThreshold = options.loopThreshold ?? 3;
    this.overlapRatio = options.overlapRatio ?? 0.15;
    this.keyOf = options.keyOf ?? ((entry) => entry.key);
  }

  /** 已收集的业务键，按首次出现顺序。 */
  keys(): K[] {
    return [...this.seen.keys()];
  }

  /** 当前状态快照。 */
  status(): CollectorStatus {
    return {
      done: this.doneReason !== null,
      reason: this.doneReason,
      keys: this.seen.size,
      stepsUsed: this.stepsUsed,
      remainingSteps: Math.max(0, this.budget.maxSteps - this.stepsUsed),
      insertions: this.insertions,
      loops: this.loops,
      coverage: this.covered.map((iv) => [iv[0], iv[1]] as const),
    };
  }

  /**
   * 消费一帧可见条目与滚动范围。
   * 以稳定业务键去重，检测循环与动态插入，并保存已覆盖区间。
   */
  ingest(entries: ReadonlyArray<VisibleEntry<K>>, range: ScrollRange): IngestReport {
    if (this.doneReason !== null) {
      return { accepted: false, newKeys: 0, duplicateKeys: 0, insertions: 0, loopDetected: false };
    }
    this.viewportSize = range.viewportSize;
    if (range.totalSize !== undefined) {
      this.totalSize = range.totalSize;
    }

    const frameKeys: K[] = [];
    let newKeys = 0;
    let duplicateKeys = 0;
    let insertions = 0;
    let firstInsertionOffset = Number.POSITIVE_INFINITY;

    for (const entry of entries) {
      const key = this.keyOf(entry);
      frameKeys.push(key);
      const prev = this.seen.get(key);
      if (prev === undefined) {
        newKeys += 1;
        // 动态插入：新键落在已覆盖区间内，说明列表在已扫过的位置发生了变化。
        if (entry.offset !== undefined && this.isCovered(entry.offset)) {
          insertions += 1;
          firstInsertionOffset = Math.min(firstInsertionOffset, entry.offset);
        }
        this.seen.set(key, { index: entry.index, offset: entry.offset });
      } else {
        duplicateKeys += 1;
        // 键位漂移：同一业务键出现在不同序号/偏移，视为动态插入引起的重排。
        if (
          (entry.index !== undefined && prev.index !== undefined && entry.index !== prev.index) ||
          (entry.offset !== undefined && prev.offset !== undefined && entry.offset !== prev.offset)
        ) {
          insertions += 1;
          firstInsertionOffset = Math.min(firstInsertionOffset, entry.offset ?? range.offset);
          this.seen.set(key, { index: entry.index, offset: entry.offset });
        }
      }
    }

    const frameStart = Math.max(0, range.offset);
    const frameEnd = Math.min(range.offset + range.viewportSize, this.totalSize ?? Number.POSITIVE_INFINITY);
    if (insertions > 0) {
      this.insertions += insertions;
      // 插入点之后的内容整体位移，已保存的覆盖区间自插入点起全部失效，
      // 迫使后续重新扫描这一带。
      this.uncover(
        firstInsertionOffset === Number.POSITIVE_INFINITY ? frameStart : firstInsertionOffset,
        Number.POSITIVE_INFINITY,
      );
    }
    this.cover(frameStart, frameEnd);

    // 循环检测：可见键签名重复且没有任何新键。
    const signature = frameKeys.map(String).join(' ');
    let loopDetected = false;
    if (newKeys === 0) {
      this.fruitless += 1;
      if (this.signatures.has(signature)) {
        loopDetected = true;
        this.loops += 1;
      }
    } else {
      this.fruitless = 0;
    }
    this.signatures.add(signature);

    this.evaluateTermination();

    return { accepted: true, newKeys, duplicateKeys, insertions, loopDetected };
  }

  /**
   * 布局事件：容器高度变化后，已保存的覆盖区间仍然有效（偏移空间不变），
   * 但步进规划作废，需要基于新区间重新规划；若此前已判定结束而覆盖
   * 不再完整，则重新打开采集。
   */
  onLayout(event: LayoutEvent): void {
    const heightChanged = event.containerHeight !== this.viewportSize;
    this.viewportSize = event.containerHeight;
    if (event.totalSize !== undefined) {
      this.totalSize = event.totalSize;
    }
    if (!heightChanged) {
      return;
    }
    this.fruitless = 0;
    if (this.doneReason === 'exhausted' && !this.isFullyCovered()) {
      this.doneReason = null;
    }
  }

  /**
   * 返回下一个建议滚动偏移；返回 null 表示采集结束
   * （已证明无新键，或公开预算耗尽）。
   */
  nextTarget(): number | null {
    if (this.doneReason !== null) {
      return null;
    }
    if (this.stepsUsed >= this.budget.maxSteps) {
      this.doneReason = 'budget';
      return null;
    }
    const target = this.planNextOffset();
    if (target === null) {
      this.doneReason = 'exhausted';
      return null;
    }
    this.stepsUsed += 1;
    return target;
  }

  private planNextOffset(): number | null {
    if (this.covered.length === 0) {
      return 0;
    }
    // 已证明无新键：总高度已知且 [0, totalSize) 被完整覆盖。
    if (this.isFullyCovered()) {
      return null;
    }
    const limit = this.totalSize ?? Number.POSITIVE_INFINITY;
    // 找第一个未覆盖的空隙，把视口起点对准它。
    let cursor = 0;
    for (const [start, end] of this.covered) {
      if (start > cursor) {
        return Math.min(cursor, Math.max(0, limit - this.viewportSize));
      }
      cursor = Math.max(cursor, end);
      if (cursor >= limit) {
        return null;
      }
    }
    if (this.totalSize !== undefined) {
      return Math.max(0, Math.min(cursor, this.totalSize - this.viewportSize));
    }
    // 总高度未知：继续向前步进，依靠 loopThreshold 证明无新键。
    return cursor;
  }

  private evaluateTermination(): void {
    if (this.budget.maxKeys !== undefined && this.seen.size >= this.budget.maxKeys) {
      this.doneReason = 'budget';
      return;
    }
    if (this.fruitless >= this.loopThreshold) {
      this.doneReason = 'exhausted';
      return;
    }
    if (this.isFullyCovered()) {
      this.doneReason = 'exhausted';
    }
  }

  private isFullyCovered(): boolean {
    if (this.totalSize === undefined || this.covered.length === 0) {
      return false;
    }
    const [start, end] = this.covered[0];
    return this.covered.length === 1 && start <= 0 && end >= this.totalSize;
  }

  private isCovered(offset: number): boolean {
    return this.covered.some(([start, end]) => offset >= start && offset < end);
  }

  private cover(start: number, end: number): void {
    const next: Array<[number, number]> = [];
    let curStart = start;
    let curEnd = end;
    for (const [ivStart, ivEnd] of this.covered) {
      if (ivEnd < curStart) {
        next.push([ivStart, ivEnd]);
      } else if (ivStart > curEnd) {
        next.push([curStart, curEnd]);
        curStart = ivStart;
        curEnd = ivEnd;
      } else {
        curStart = Math.min(curStart, ivStart);
        curEnd = Math.max(curEnd, ivEnd);
      }
    }
    next.push([curStart, curEnd]);
    next.sort((a, b) => a[0] - b[0]);
    this.covered = next;
  }

  private uncover(start: number, end: number): void {
    const next: Array<[number, number]> = [];
    for (const [ivStart, ivEnd] of this.covered) {
      if (ivEnd <= start || ivStart >= end) {
        next.push([ivStart, ivEnd]);
        continue;
      }
      if (ivStart < start) {
        next.push([ivStart, start]);
      }
      if (ivEnd > end) {
        next.push([end, ivEnd]);
      }
    }
    this.covered = next;
  }
}
