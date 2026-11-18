import { DriftBoundedClock, type Clock, type SyncResult } from './clock.js';
import { SlidingWindow, type WindowRecord } from './sliding-window.js';
import type {
  EmittedQuotaEvent,
  NodeSnapshot,
  NodeStats,
  QuotaEvent,
  ReleaseReason,
  ReservationSnapshot,
  ReserveResult,
} from './types.js';

export interface QuotaNodeOptions {
  id: string;
  shardLimit: number;
  windowMs: number;
  maxClockDriftMs?: number;
  reservationTtlMs: number;
  clock: Clock;
  physicalSkewMs?: number;
}

export class QuotaNode {
  readonly id: string;
  readonly shardLimit: number;
  readonly windowMs: number;
  readonly maxClockDriftMs: number;
  readonly effectiveWindowMs: number;
  readonly reservationTtlMs: number;
  readonly clock: DriftBoundedClock;

  #ledger: SlidingWindow;
  #active = new Map<string, { at: number; expiresAt: number }>();
  #outbox: QuotaEvent[] = [];
  #seq = 0;
  #closed = false;
  #stats: NodeStats = {
    accepted: 0,
    failed: 0,
    duplicates: 0,
    committed: 0,
    releasedExplicit: 0,
    releasedTimeout: 0,
  };

  constructor(options: QuotaNodeOptions) {
    if (typeof options.id !== 'string' || options.id.length === 0) {
      throw new RangeError('node id must be a non-empty string');
    }
    if (options.id.includes('\u0000')) {
      throw new RangeError('node id must not contain NUL');
    }
    if (!Number.isInteger(options.shardLimit) || options.shardLimit <= 0) {
      throw new RangeError('shardLimit must be a positive integer');
    }
    if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
      throw new RangeError('windowMs must be a finite positive number');
    }
    if (
      !Number.isFinite(options.reservationTtlMs) ||
      options.reservationTtlMs <= 0
    ) {
      throw new RangeError('reservationTtlMs must be a finite positive number');
    }
    const maxClockDriftMs = options.maxClockDriftMs ?? 0;
    if (!Number.isFinite(maxClockDriftMs) || maxClockDriftMs < 0) {
      throw new RangeError('maxClockDriftMs must be a finite non-negative number');
    }

    this.id = options.id;
    this.shardLimit = options.shardLimit;
    this.windowMs = options.windowMs;
    this.maxClockDriftMs = maxClockDriftMs;
    this.effectiveWindowMs = options.windowMs + 2 * maxClockDriftMs;
    this.reservationTtlMs = options.reservationTtlMs;
    this.clock = new DriftBoundedClock(
      options.clock,
      maxClockDriftMs,
      options.physicalSkewMs ?? 0,
    );
    this.#ledger = new SlidingWindow(this.effectiveWindowMs);
  }

  get stats(): NodeStats {
    return { ...this.#stats };
  }

  get pendingEvents(): number {
    return this.#outbox.length;
  }

  synchronize(referenceNow: number): SyncResult {
    return this.clock.synchronize(referenceNow);
  }

  reserve(reservationId: string): ReserveResult {
    if (this.#closed) {
      return {
        ok: false,
        reason: 'closed',
        remaining: this.#ledger.remainingAt(
          this.clock.now(),
          this.shardLimit,
        ),
      };
    }
    if (
      typeof reservationId !== 'string' ||
      reservationId.length === 0 ||
      reservationId.includes('\u0000')
    ) {
      this.#stats.failed += 1;
      return { ok: false, reason: 'invalid', remaining: this.remainingQuota() };
    }

    const at = this.clock.now();
    this.#expire(at);

    if (this.#active.has(reservationId) || this.#ledger.has(reservationId)) {
      this.#stats.failed += 1;
      this.#stats.duplicates += 1;
      return {
        ok: false,
        reason: 'duplicate',
        remaining: this.#ledger.remainingAt(at, this.shardLimit),
      };
    }

    if (!this.#ledger.admit(at, this.shardLimit)) {
      this.#stats.failed += 1;
      return {
        ok: false,
        reason: 'shard_exhausted',
        remaining: this.#ledger.remainingAt(at, this.shardLimit),
      };
    }

    const expiresAt = at + this.reservationTtlMs;
    this.#ledger.add({ id: reservationId, at, state: 'reserved' });
    this.#active.set(reservationId, { at, expiresAt });
    this.#stats.accepted += 1;
    this.#emit({
      kind: 'reserve',
      nodeId: this.id,
      reservationId,
      at,
      expiresAt,
    });

    return {
      ok: true,
      reservation: {
        id: reservationId,
        nodeId: this.id,
        at,
        expiresAt,
        state: 'reserved',
      },
      remaining: this.#ledger.remainingAt(at, this.shardLimit),
    };
  }

  commit(reservationId: string): boolean {
    const at = this.clock.now();
    this.#expire(at);
    if (!this.#active.has(reservationId)) {
      return false;
    }
    if (!this.#ledger.commit(reservationId)) {
      return false;
    }
    this.#active.delete(reservationId);
    this.#stats.committed += 1;
    this.#emit({
      kind: 'commit',
      nodeId: this.id,
      reservationId,
      at,
    });
    return true;
  }

  release(reservationId: string, reason: ReleaseReason = 'explicit'): boolean {
    const at = this.clock.now();
    this.#expire(at);
    if (!this.#active.has(reservationId)) {
      return false;
    }
    if (!this.#ledger.release(reservationId)) {
      return false;
    }
    this.#active.delete(reservationId);
    if (reason === 'timeout') {
      this.#stats.releasedTimeout += 1;
    } else {
      this.#stats.releasedExplicit += 1;
    }
    this.#emit({
      kind: 'release',
      nodeId: this.id,
      reservationId,
      at,
      reason,
    });
    return true;
  }

  tick(): number {
    return this.#expire(this.clock.now());
  }

  remainingQuota(now = this.clock.now()): number {
    this.#expire(now);
    return this.#ledger.remainingAt(now, this.shardLimit);
  }

  usageAt(now = this.clock.now()): number {
    return this.#ledger.usageAt(now);
  }

  records(): WindowRecord[] {
    return this.#ledger.records();
  }

  activeReservations(): ReservationSnapshot[] {
    return [...this.#active.entries()]
      .map(([id, value]) => ({
        id,
        nodeId: this.id,
        at: value.at,
        expiresAt: value.expiresAt,
        state: 'reserved' as const,
      }))
      .sort((left, right) => left.at - right.at || left.id.localeCompare(right.id));
  }

  maxWindowUsage(): number {
    return this.#ledger.maxUsage();
  }

  compact(): number {
    return this.#ledger.compact(this.clock.now());
  }

  snapshot(): NodeSnapshot {
    const now = this.clock.now();
    this.#expire(now);
    const records = this.#ledger.records();
    const inWindow = records.filter(
      (record) => record.at > now - this.effectiveWindowMs && record.at <= now,
    );
    return {
      id: this.id,
      shardLimit: this.shardLimit,
      windowMs: this.windowMs,
      effectiveWindowMs: this.effectiveWindowMs,
      now,
      activeReservations: this.#active.size,
      reservedInWindow: inWindow.filter((record) => record.state === 'reserved').length,
      passedInWindow: inWindow.filter((record) => record.state === 'passed').length,
      remaining: this.#ledger.remainingAt(now, this.shardLimit),
      pendingEvents: this.#outbox.length,
      stats: { ...this.#stats },
    };
  }

  pending(): QuotaEvent[] {
    return this.#outbox.map((event) => ({ ...event }));
  }

  drainEvents(): QuotaEvent[] {
    const events = this.#outbox;
    this.#outbox = [];
    return events;
  }

  close(): void {
    this.#closed = true;
  }

  #expire(now: number): number {
    let expired = 0;
    for (const [id, reservation] of this.#active) {
      if (reservation.expiresAt <= now) {
        this.#ledger.release(id);
        this.#active.delete(id);
        this.#stats.releasedTimeout += 1;
        expired += 1;
        this.#emit({
          kind: 'release',
          nodeId: this.id,
          reservationId: id,
          at: now,
          reason: 'timeout',
        });
      }
    }
    return expired;
  }

  #emit(event: EmittedQuotaEvent): void {
    this.#seq += 1;
    this.#outbox.push({ ...event, seq: this.#seq } as QuotaEvent);
  }
}
