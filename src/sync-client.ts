import { compareCursors } from './cursor.ts';
import type { FetchPage, VersionedNode } from './relay.ts';

export const START_POSITION = '@start';

export interface CheckpointStore {
  load(): string | null;
  save(cursor: string): void;
}

export class MemoryCheckpointStore implements CheckpointStore {
  private cursor: string | null = null;

  load(): string | null {
    return this.cursor;
  }

  save(cursor: string): void {
    this.cursor = cursor;
  }
}

export type ViolationReason = 'not-advanced' | 'regressed';

export class CursorViolationError extends Error {
  readonly reason: ViolationReason;
  readonly attempts: number;

  constructor(reason: ViolationReason, attempts: number, detail: string) {
    super(`cursor ${reason}; bounded recovery exhausted after ${attempts} attempt(s): ${detail}`);
    this.name = 'CursorViolationError';
    this.reason = reason;
    this.attempts = attempts;
  }
}

export interface SyncItem<T extends VersionedNode> {
  node: T;
  key: string;
  version: number;
  cursor: string;
  firstSeenAt: string;
}

export interface Batch<T extends VersionedNode> {
  batchId: number;
  items: Array<SyncItem<T>>;
  startCursor: string | null;
  endCursor: string;
}

export interface SyncClientOptions<T extends VersionedNode> {
  fetchPage: FetchPage<T>;
  checkpoint?: CheckpointStore;
  pageSize?: number;
  batchSize?: number;
  maxRecoveryAttempts?: number;
  overlapWindow?: number;
}

interface SeenEntry {
  version: number;
  firstSeenAt: string;
}

export class SyncClient<T extends VersionedNode> {
  private readonly fetchPage: FetchPage<T>;
  private readonly checkpoint: CheckpointStore;
  private readonly pageSize: number;
  private readonly batchSize: number;
  private readonly maxRecoveryAttempts: number;
  private readonly overlapWindow: number;
  private readonly seen = new Map<string, SeenEntry>();
  private cancelled = false;
  private nextBatchId = 1;

  constructor(options: SyncClientOptions<T>) {
    this.fetchPage = options.fetchPage;
    this.checkpoint = options.checkpoint ?? new MemoryCheckpointStore();
    this.pageSize = options.pageSize ?? 100;
    this.batchSize = options.batchSize ?? this.pageSize;
    this.maxRecoveryAttempts = options.maxRecoveryAttempts ?? 3;
    this.overlapWindow = options.overlapWindow ?? 1024;
  }

  get lastAckedCursor(): string | null {
    return this.checkpoint.load();
  }

  cancel(): void {
    this.cancelled = true;
  }

  ack(batch: Batch<T>): void {
    this.checkpoint.save(batch.endCursor);
  }

  private rememberSeen(key: string, version: number, firstSeenAt: string): void {
    this.seen.delete(key);
    this.seen.set(key, { version, firstSeenAt });
    while (this.seen.size > this.overlapWindow) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }

  async *run(): AsyncGenerator<Batch<T>, void, undefined> {
    let after: string | null = this.checkpoint.load();
    let lastEndCursor: string | null = after;
    let recoveryAttempts = 0;
    let pending: Array<SyncItem<T>> = [];
    let pendingStart: string | null = after;

    while (!this.cancelled) {
      const connection = await this.fetchPage(after, this.pageSize);
      const lastEdgeCursor = connection.edges.length > 0
        ? connection.edges[connection.edges.length - 1]!.cursor
        : null;
      const effectiveEnd = connection.pageInfo.endCursor ?? lastEdgeCursor;

      if (effectiveEnd === null && connection.pageInfo.hasNextPage) {
        recoveryAttempts += 1;
        if (recoveryAttempts > this.maxRecoveryAttempts) {
          throw new CursorViolationError(
            'not-advanced',
            recoveryAttempts,
            'page exposes no end cursor but claims a next page',
          );
        }
        after = lastEndCursor;
        continue;
      }

      if (effectiveEnd !== null && lastEndCursor !== null) {
        const cmp = compareCursors(effectiveEnd, lastEndCursor);
        if (cmp <= 0) {
          recoveryAttempts += 1;
          if (recoveryAttempts > this.maxRecoveryAttempts) {
            throw new CursorViolationError(
              cmp === 0 ? 'not-advanced' : 'regressed',
              recoveryAttempts,
              'pageInfo.endCursor did not move past the last confirmed position',
            );
          }
          after = lastEndCursor;
          continue;
        }
      }

      recoveryAttempts = 0;
      const position = after ?? START_POSITION;

      for (const edge of connection.edges) {
        const key = edge.node.id;
        const seen = this.seen.get(key);
        if (seen !== undefined && seen.version === edge.node.version) continue;
        const firstSeenAt = seen?.firstSeenAt ?? position;
        this.rememberSeen(key, edge.node.version, firstSeenAt);
        if (pending.length === 0) pendingStart = after;
        pending.push({
          node: edge.node,
          key,
          version: edge.node.version,
          cursor: edge.cursor,
          firstSeenAt,
        });
        if (pending.length >= this.batchSize) {
          const batch: Batch<T> = {
            batchId: this.nextBatchId++,
            items: pending,
            startCursor: pendingStart,
            endCursor: pending[pending.length - 1]!.cursor,
          };
          pending = [];
          yield batch;
          if (this.cancelled) return;
        }
      }

      if (effectiveEnd !== null) {
        lastEndCursor = effectiveEnd;
        after = effectiveEnd;
      }

      if (!connection.pageInfo.hasNextPage) {
        if (pending.length > 0 && !this.cancelled) {
          yield {
            batchId: this.nextBatchId++,
            items: pending,
            startCursor: pendingStart,
            endCursor: pending[pending.length - 1]!.cursor,
          };
        }
        return;
      }
    }
  }
}
