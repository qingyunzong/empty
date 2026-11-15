/**
 * 分区发现状态库：从最终一致的目录列举中识别 hive 风格分区。
 *
 * 语义：
 * - 新目录需连续两次（可配置）观察且出现完成标记（如 `_SUCCESS`）才发布；
 * - 已发布分区暂时消失不立即删除，连续缺席超过阈值才发出移除事件；
 * - 每轮持久化 continuation token、清单世代与待确认项；
 *   重启后重放同一世代不会产生重复发布。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 一轮目录列举的单个条目。 */
export interface ListingEntry {
  /** hive 风格相对路径，如 `dt=2026-11-15/hour=08`。 */
  path: string;
  /** 该目录下是否观察到完成标记（如 `_SUCCESS`）。 */
  complete: boolean;
}

/** 一轮最终一致的列举结果（清单）。 */
export interface ListingBatch {
  /** 清单世代，单调递增；小于等于已处理世代的批次会被幂等忽略。 */
  generation: number;
  /** 供下一轮续传列举使用的 continuation token。 */
  continuationToken: string;
  entries: ListingEntry[];
}

/** 待确认（尚未发布）的分区。 */
export interface PendingPartition {
  path: string;
  /** 截至上一轮为止的连续观察次数。 */
  consecutiveSeen: number;
  /** 历史上是否观察到过完成标记。 */
  markerSeen: boolean;
  firstSeenGeneration: number;
  lastSeenGeneration: number;
}

/** 已发布的分区。 */
export interface PublishedPartition {
  path: string;
  publishedGeneration: number;
  /** 连续缺席的轮数（最终一致列举下的短暂消失容忍）。 */
  missingRounds: number;
}

/** 需要持久化的完整发现状态。 */
export interface DiscoveryState {
  continuationToken: string | null;
  lastGeneration: number;
  pending: Record<string, PendingPartition>;
  published: Record<string, PublishedPartition>;
}

/** 一轮处理后产生的事件。 */
export interface DiscoveryEvents {
  /** 本轮新发布的分区路径。 */
  published: string[];
  /** 本轮确认移除的分区路径。 */
  removed: string[];
  /** 因世代未前进而被忽略的批次为 true。 */
  stale: boolean;
}

export interface DiscoveryOptions {
  /** 发布前需要的连续观察次数，默认 2。 */
  requiredConsecutiveObservations?: number;
  /** 已发布分区连续缺席多少轮后才移除，默认 2。 */
  missingRoundsBeforeRemoval?: number;
}

interface ResolvedOptions {
  requiredConsecutiveObservations: number;
  missingRoundsBeforeRemoval: number;
}

const HIVE_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*=[^/=]+$/;

/** 判断路径是否为合法的 hive 风格分区路径（`k=v` 段，无空段与 `..`）。 */
export function isHivePartitionPath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.endsWith("/")) {
    return false;
  }
  const segments = path.split("/");
  return segments.every((segment) => HIVE_SEGMENT.test(segment));
}

export function emptyState(): DiscoveryState {
  return {
    continuationToken: null,
    lastGeneration: 0,
    pending: {},
    published: {},
  };
}

function resolveOptions(options: DiscoveryOptions): ResolvedOptions {
  return {
    requiredConsecutiveObservations:
      options.requiredConsecutiveObservations ?? 2,
    missingRoundsBeforeRemoval: options.missingRoundsBeforeRemoval ?? 2,
  };
}

/**
 * 纯函数：将一轮清单应用到既有状态上，返回新状态与事件。
 * 不修改入参；调用方负责持久化返回的 state。
 */
export function reduceRound(
  state: DiscoveryState,
  batch: ListingBatch,
  options: DiscoveryOptions = {},
): { state: DiscoveryState; events: DiscoveryEvents } {
  const opts = resolveOptions(options);

  if (batch.generation <= state.lastGeneration) {
    return {
      state,
      events: { published: [], removed: [], stale: true },
    };
  }

  const observed = new Map<string, boolean>();
  for (const entry of batch.entries) {
    if (!isHivePartitionPath(entry.path)) {
      continue;
    }
    observed.set(entry.path, (observed.get(entry.path) ?? false) || entry.complete);
  }

  const events: DiscoveryEvents = { published: [], removed: [], stale: false };
  const pending: Record<string, PendingPartition> = {};
  const published: Record<string, PublishedPartition> = {};

  for (const [path, item] of Object.entries(state.published)) {
    if (observed.has(path)) {
      published[path] = { ...item, missingRounds: 0 };
      observed.delete(path);
    } else {
      const missingRounds = item.missingRounds + 1;
      if (missingRounds > opts.missingRoundsBeforeRemoval) {
        events.removed.push(path);
      } else {
        published[path] = { ...item, missingRounds };
      }
    }
  }

  for (const [path, item] of Object.entries(state.pending)) {
    const complete = observed.get(path);
    if (complete === undefined) {
      // 本轮未出现：连续观察中断，计数清零但保留标记历史。
      pending[path] = { ...item, consecutiveSeen: 0 };
    } else {
      observed.delete(path);
      pending[path] = {
        ...item,
        consecutiveSeen: item.consecutiveSeen + 1,
        markerSeen: item.markerSeen || complete,
        lastSeenGeneration: batch.generation,
      };
    }
  }

  for (const [path, complete] of observed) {
    pending[path] = {
      path,
      consecutiveSeen: 1,
      markerSeen: complete,
      firstSeenGeneration: batch.generation,
      lastSeenGeneration: batch.generation,
    };
  }

  for (const [path, item] of Object.entries(pending)) {
    if (
      item.consecutiveSeen >= opts.requiredConsecutiveObservations &&
      item.markerSeen
    ) {
      published[path] = {
        path,
        publishedGeneration: batch.generation,
        missingRounds: 0,
      };
      events.published.push(path);
      delete pending[path];
    }
  }

  events.published.sort();
  events.removed.sort();

  return {
    state: {
      continuationToken: batch.continuationToken,
      lastGeneration: batch.generation,
      pending,
      published,
    },
    events,
  };
}

/** 状态持久化接口，由调用方按存储介质实现。 */
export interface StateStore {
  load(): Promise<DiscoveryState | null>;
  save(state: DiscoveryState): Promise<void>;
}

/** 基于本地文件的状态存储（临时文件 + 原子改名）。 */
export class FileStateStore implements StateStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<DiscoveryState | null> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(raw) as DiscoveryState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async save(state: DiscoveryState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = join(
      dirname(this.filePath),
      `.${Date.now()}-${process.pid}.tmp`,
    );
    await writeFile(tmpPath, JSON.stringify(state, null, 2), "utf8");
    await rename(tmpPath, this.filePath);
  }
}

/**
 * 分区发现器：持有状态并在每轮后自动持久化。
 * 重启时用同一 store 重新构造即可恢复，重放已处理世代不会重复发布。
 */
export class PartitionDiscovery {
  private state: DiscoveryState;

  private constructor(
    private readonly store: StateStore,
    private readonly options: DiscoveryOptions,
    initial: DiscoveryState,
  ) {
    this.state = initial;
  }

  static async open(
    store: StateStore,
    options: DiscoveryOptions = {},
  ): Promise<PartitionDiscovery> {
    const loaded = await store.load();
    return new PartitionDiscovery(store, options, loaded ?? emptyState());
  }

  /** 应用一轮清单，持久化新状态并返回本轮事件。 */
  async applyRound(batch: ListingBatch): Promise<DiscoveryEvents> {
    const { state, events } = reduceRound(this.state, batch, this.options);
    if (!events.stale) {
      this.state = state;
      await this.store.save(state);
    }
    return events;
  }

  getState(): DiscoveryState {
    return this.state;
  }
}
