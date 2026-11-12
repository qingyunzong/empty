import { assertWellFormed, BatchRejectedError, eventsEqual } from './errors.js';
import { replayDownload } from './replay.js';
import type {
  ArchiveDelta,
  ArchivedDownload,
  BatchResult,
  DownloadEvent,
  DownloadView,
} from './types.js';

interface JournalEntry {
  readonly downloadId: string;
  readonly seq: number;
}

/** 可序列化的完整状态包，宿主可持久化后再 import 恢复。 */
export interface StoreSnapshot {
  readonly version: 1;
  readonly events: readonly DownloadEvent[];
  readonly archives: readonly ArchivedDownload[];
}

/**
 * 下载采集状态存储。
 *
 * 事件允许乱序、分批到达：begin 未到的片段进入暂存桶，begin 到达后随下一次
 * 受影响批次一起按序号重放。每次 ingest 只重放受影响下载，输出归档的删除/新增
 * 净差；任何冲突或非法 progress 都会让整批回滚到调用前状态。
 */
export class DownloadStateStore {
  /** 全局序号 -> 事件，保证序号全局唯一。 */
  readonly #bySeq = new Map<number, DownloadEvent>();
  /** 事件 ID -> 事件，保证事件 ID 全局唯一并支持重投识别。 */
  readonly #byEventId = new Map<string, DownloadEvent>();
  /** 下载 ID -> 该下载的全部事件（含 begin 未到的暂存片段）。 */
  readonly #byDownload = new Map<string, DownloadEvent[]>();
  /** 已就绪归档：下载 ID -> 归档。 */
  readonly #archives = new Map<string, ArchivedDownload>();

  /**
   * 投递一个批次。成功返回接受数、重投忽略项与归档净差；失败抛出
   * BatchRejectedError 且不留下任何批次内副作用。
   */
  ingest(batch: readonly DownloadEvent[]): BatchResult {
    if (!Array.isArray(batch)) {
      throw new BatchRejectedError('MALFORMED_EVENT', 'ingest expects an array of events');
    }

    const journal: JournalEntry[] = [];
    const ignoredDuplicates: DownloadEvent[] = [];
    const affected = new Set<string>();

    try {
      for (const event of batch) {
        assertWellFormed(event);

        const byId = this.#byEventId.get(event.eventId);
        if (byId !== undefined) {
          if (eventsEqual(byId, event)) {
            // 相同事件重投：幂等忽略，不进入重放。
            ignoredDuplicates.push(event);
            continue;
          }
          throw new BatchRejectedError(
            'CONFLICT_EVENT_ID',
            `eventId ${event.eventId} reused with a different payload`,
            { downloadId: event.downloadId, eventId: event.eventId, seq: event.seq },
          );
        }

        const bySeq = this.#bySeq.get(event.seq);
        if (bySeq !== undefined) {
          throw new BatchRejectedError(
            'CONFLICT_SEQ',
            `seq ${event.seq} already assigned to event ${bySeq.eventId}`,
            { downloadId: event.downloadId, eventId: event.eventId, seq: event.seq },
          );
        }

        this.#bySeq.set(event.seq, event);
        this.#byEventId.set(event.eventId, event);
        const bucket = this.#byDownload.get(event.downloadId);
        if (bucket === undefined) {
          this.#byDownload.set(event.downloadId, [event]);
        } else {
          bucket.push(event);
        }
        journal.push({ downloadId: event.downloadId, seq: event.seq });
        affected.add(event.downloadId);
      }

      // 全部落桶成功后再统一重放；重放抛错会被捕获并回滚。
      const deltas: ArchiveDelta[] = [];
      const affectedIds = [...affected].sort();
      for (const downloadId of affectedIds) {
        const bucket = this.#byDownload.get(downloadId);
        if (bucket === undefined) {
          continue;
        }
        const output = replayDownload(downloadId, bucket);
        const previous = this.#archives.get(downloadId) ?? null;
        const next = output.archive;

        if (!archivedEqual(previous, next)) {
          deltas.push({ downloadId, removed: previous, added: next });
        }
        if (next === null) {
          this.#archives.delete(downloadId);
        } else {
          this.#archives.set(downloadId, next);
        }
      }

      return {
        accepted: journal.length,
        ignoredDuplicates,
        affectedDownloads: affectedIds,
        deltas,
      };
    } catch (error) {
      this.#rollback(journal);
      throw error;
    }
  }

  #rollback(journal: readonly JournalEntry[]): void {
    for (let index = journal.length - 1; index >= 0; index -= 1) {
      const entry = journal[index];
      if (entry === undefined) {
        continue;
      }
      const event = this.#bySeq.get(entry.seq);
      this.#bySeq.delete(entry.seq);
      if (event !== undefined) {
        this.#byEventId.delete(event.eventId);
      }
      const bucket = this.#byDownload.get(entry.downloadId);
      if (bucket !== undefined) {
        const at = bucket.findIndex((candidate) => candidate.seq === entry.seq);
        if (at >= 0) {
          bucket.splice(at, 1);
        }
        if (bucket.length === 0) {
          this.#byDownload.delete(entry.downloadId);
        }
      }
    }
  }

  /** 查询单个下载的当前视图（只读，不改变存储）。 */
  getDownload(downloadId: string): DownloadView | null {
    const bucket = this.#byDownload.get(downloadId);
    if (bucket === undefined) {
      return null;
    }
    const output = replayDownload(downloadId, bucket);
    const archive = this.#archives.get(downloadId) ?? null;

    let stage: DownloadView['stage'];
    if (!output.begun) {
      stage = 'staged';
    } else if (output.terminal === null) {
      stage = 'active';
    } else {
      stage = output.terminal.kind;
    }

    return {
      downloadId,
      stage,
      begun: output.begun,
      url: output.url,
      received: output.received,
      total: output.total,
      terminalReady: output.terminalReady,
      archive,
    };
  }

  /** 当前全部归档的快照。 */
  listArchives(): ArchivedDownload[] {
    return [...this.#archives.values()].sort((left, right) =>
      left.downloadId.localeCompare(right.downloadId),
    );
  }

  /** 导出可持久化的状态包。 */
  exportSnapshot(): StoreSnapshot {
    return {
      version: 1,
      events: [...this.#bySeq.values()].sort((left, right) => left.seq - right.seq),
      archives: this.listArchives(),
    };
  }

  /** 从状态包恢复；重放全部事件以重建归档并校验一致性。 */
  static importSnapshot(snapshot: StoreSnapshot): DownloadStateStore {
    if (snapshot === null || typeof snapshot !== 'object' || snapshot.version !== 1) {
      throw new BatchRejectedError('MALFORMED_EVENT', 'unsupported snapshot version');
    }
    const store = new DownloadStateStore();
    if (snapshot.events.length > 0) {
      store.ingest([...snapshot.events]);
    }
    return store;
  }
}

function archivedEqual(
  left: ArchivedDownload | null,
  right: ArchivedDownload | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return (
    left.downloadId === right.downloadId &&
    left.kind === right.kind &&
    left.url === right.url &&
    left.summary === right.summary &&
    left.terminalSeq === right.terminalSeq &&
    left.received === right.received &&
    left.total === right.total
  );
}
