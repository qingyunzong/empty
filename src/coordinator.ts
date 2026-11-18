import { ManualClock, type SyncResult } from './clock.js';
import { QuotaNode } from './node.js';
import { partitionQuota, type ShardAllocation } from './partition.js';
import { SlidingWindow, type WindowRecord } from './sliding-window.js';
import type {
  QuotaEvent,
  ReleaseReason,
  ReserveResult,
} from './types.js';

export interface ClusterNodeConfig {
  id: string;
  shardLimit?: number;
  physicalSkewMs?: number;
}

export interface QuotaClusterOptions {
  quota: number;
  windowMs: number;
  reservationTtlMs: number;
  maxClockDriftMs?: number;
  nodes: readonly (string | ClusterNodeConfig)[];
  referenceClock?: ManualClock;
  syncOnReconcile?: boolean;
}

export interface ReconcileReport {
  referenceNow: number;
  applied: number;
  timeouts: number;
  duplicates: number;
  nodes: Array<{
    id: string;
    applied: number;
    buffered: number;
    lastSeq: number;
  }>;
  violations: string[];
}

export interface IngestReport {
  applied: number;
  duplicates: number;
  buffered: number;
  violations: string[];
}

export interface NodeAudit {
  id: string;
  shardLimit: number;
  maxWindowUsage: number;
  localMaxWindowUsage: number;
  liveReserved: number;
  passedInLedger: number;
  accepted: number;
  committed: number;
  released: number;
  pendingEvents: number;
  bufferedEvents: number;
  duplicateEvents: number;
  driftMs: number;
  withinDriftBound: boolean;
  conserved: boolean;
}

export interface AuditReport {
  ok: boolean;
  referenceNow: number;
  quota: number;
  windowMs: number;
  effectiveWindowMs: number;
  maxClockDriftMs: number;
  totalShardLimit: number;
  globalMaxWindowUsage: number;
  nodes: NodeAudit[];
  violations: string[];
  inSync: boolean;
}

interface NodeState {
  node: QuotaNode;
  rawClock: ManualClock;
  limit: number;
  ledger: SlidingWindow;
  lastSeq: number;
  buffered: Map<number, QuotaEvent>;
  accepted: number;
  passed: number;
  released: number;
  duplicateEvents: number;
  violations: string[];
}

function normalizeNodes(
  nodes: readonly (string | ClusterNodeConfig)[],
  quota: number,
): ShardAllocation[] {
  if (nodes.length === 0) {
    throw new RangeError('at least one node is required');
  }
  const configs = nodes.map((node) =>
    typeof node === 'string' ? { id: node } : node,
  );
  const ids = configs.map((config) => config.id);
  if (new Set(ids).size !== ids.length) {
    throw new RangeError('node ids must be unique');
  }
  const provided = configs.filter((config) => config.shardLimit !== undefined);
  if (provided.length !== 0 && provided.length !== configs.length) {
    throw new RangeError('either set shardLimit on every node or on none');
  }
  if (provided.length === 0) {
    return partitionQuota(quota, ids);
  }

  const allocations = configs.map((config) => ({
    id: config.id,
    limit: config.shardLimit as number,
  }));
  let total = 0;
  for (const allocation of allocations) {
    if (!Number.isInteger(allocation.limit) || allocation.limit <= 0) {
      throw new RangeError(`shardLimit for ${allocation.id} must be a positive integer`);
    }
    total += allocation.limit;
  }
  if (total > quota) {
    throw new RangeError('shard limits must not exceed the global quota');
  }
  return allocations;
}

export class QuotaCoordinator {
  readonly quota: number;
  readonly windowMs: number;
  readonly maxClockDriftMs: number;
  readonly effectiveWindowMs: number;
  readonly reservationTtlMs: number;
  readonly referenceClock: ManualClock;
  readonly totalShardLimit: number;

  #nodes = new Map<string, NodeState>();
  #globalLedger: SlidingWindow;
  #syncOnReconcile: boolean;

  constructor(options: QuotaClusterOptions) {
    if (!Number.isInteger(options.quota) || options.quota <= 0) {
      throw new RangeError('quota must be a positive integer');
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

    this.quota = options.quota;
    this.windowMs = options.windowMs;
    this.maxClockDriftMs = maxClockDriftMs;
    this.effectiveWindowMs = options.windowMs + 2 * maxClockDriftMs;
    this.reservationTtlMs = options.reservationTtlMs;
    this.referenceClock = options.referenceClock ?? new ManualClock(0);
    this.#syncOnReconcile = options.syncOnReconcile ?? true;
    this.#globalLedger = new SlidingWindow(this.effectiveWindowMs);

    const allocations = normalizeNodes(options.nodes, options.quota);
    this.totalShardLimit = allocations.reduce(
      (sum, allocation) => sum + allocation.limit,
      0,
    );
    if (this.totalShardLimit > this.quota) {
      throw new RangeError('shard limits must not exceed the global quota');
    }

    for (const allocation of allocations) {
      const config = options.nodes.find((node) =>
        typeof node === 'string'
          ? node === allocation.id
          : node.id === allocation.id,
      ) as string | ClusterNodeConfig | undefined;
      const physicalSkewMs =
        config !== undefined && typeof config !== 'string'
          ? config.physicalSkewMs ?? 0
          : 0;
      const rawClock = new ManualClock(this.referenceClock.now());
      const node = new QuotaNode({
        id: allocation.id,
        shardLimit: allocation.limit,
        windowMs: this.windowMs,
        maxClockDriftMs: this.maxClockDriftMs,
        reservationTtlMs: this.reservationTtlMs,
        clock: rawClock,
        physicalSkewMs,
      });
      node.synchronize(this.referenceClock.now());
      this.#nodes.set(allocation.id, {
        node,
        rawClock,
        limit: allocation.limit,
        ledger: new SlidingWindow(this.effectiveWindowMs),
        lastSeq: 0,
        buffered: new Map(),
        accepted: 0,
        passed: 0,
        released: 0,
        duplicateEvents: 0,
        violations: [],
      });
    }
  }

  node(id: string): QuotaNode {
    return this.#state(id).node;
  }

  reserve(nodeId: string, reservationId: string): ReserveResult {
    return this.node(nodeId).reserve(reservationId);
  }

  commit(nodeId: string, reservationId: string): boolean {
    return this.node(nodeId).commit(reservationId);
  }

  release(
    nodeId: string,
    reservationId: string,
    reason: ReleaseReason = 'explicit',
  ): boolean {
    return this.node(nodeId).release(reservationId, reason);
  }

  advance(ms: number): number {
    this.referenceClock.advance(ms);
    for (const state of this.#nodes.values()) {
      state.rawClock.advance(ms);
    }
    return this.referenceClock.now();
  }

  advanceNodeClock(nodeId: string, ms: number): number {
    return this.#state(nodeId).rawClock.adjust(ms);
  }

  setNodeClockSkew(nodeId: string, skewMs: number): void {
    this.node(nodeId).clock.setPhysicalSkew(skewMs);
  }

  sync(): Map<string, SyncResult>;
  sync(nodeId: string): SyncResult;
  sync(nodeId?: string): SyncResult | Map<string, SyncResult> {
    const now = this.referenceClock.now();
    if (nodeId !== undefined) {
      return this.node(nodeId).synchronize(now);
    }
    const results = new Map<string, SyncResult>();
    for (const [id, state] of this.#nodes) {
      results.set(id, state.node.synchronize(now));
    }
    return results;
  }

  reconcile(): ReconcileReport {
    const referenceNow = this.referenceClock.now();
    const violations: string[] = [];
    const nodeReports: Array<{
      id: string;
      applied: number;
      buffered: number;
      lastSeq: number;
    }> = [];
    let applied = 0;
    let timeouts = 0;
    let duplicates = 0;

    for (const [id, state] of this.#nodes) {
      if (this.#syncOnReconcile) {
        state.node.synchronize(referenceNow);
      }
      timeouts += state.node.tick();
      const events = state.node.drainEvents();
      const result = this.#apply(state, events);
      applied += result.applied;
      duplicates += result.duplicates;
      violations.push(...result.violations);
      nodeReports.push({
        id,
        applied: result.applied,
        buffered: state.buffered.size,
        lastSeq: state.lastSeq,
      });
    }

    return {
      referenceNow,
      applied,
      timeouts,
      duplicates,
      nodes: nodeReports,
      violations,
    };
  }

  ingest(nodeId: string, events: readonly QuotaEvent[]): IngestReport {
    return this.#apply(this.#state(nodeId), events);
  }

  compact(): number {
    const now = this.referenceClock.now();
    let removed = 0;
    for (const state of this.#nodes.values()) {
      removed += state.node.compact();
      removed += state.ledger.compact(now);
    }
    removed += this.#globalLedger.compact(now);
    return removed;
  }

  audit(): AuditReport {
    const referenceNow = this.referenceClock.now();
    const violations: string[] = [];
    const nodes: NodeAudit[] = [];
    let inSync = true;

    for (const [id, state] of this.#nodes) {
      state.node.tick();
      const localStats = state.node.stats;
      const active = state.node.activeReservations();
      const localRecords = state.node.records();
      const localReserved = localRecords.filter(
        (record) => record.state === 'reserved',
      ).length;
      const localMaxWindowUsage = state.node.maxWindowUsage();
      const globalRecords = state.ledger.records();
      const liveReserved = globalRecords.filter(
        (record) => record.state === 'reserved',
      ).length;
      const globalPassed = globalRecords.filter(
        (record) => record.state === 'passed',
      ).length;
      const localReleased =
        localStats.releasedExplicit + localStats.releasedTimeout;
      const localConserved =
        localStats.accepted ===
        active.length + localStats.committed + localReleased;
      const globalConserved =
        state.accepted === liveReserved + state.passed + state.released;
      const nodeInSync =
        state.node.pendingEvents === 0 &&
        state.accepted === localStats.accepted &&
        state.passed === localStats.committed &&
        state.released === localReleased &&
        state.buffered.size === 0 &&
        state.violations.length === 0;
      if (!nodeInSync) {
        inSync = false;
      }
      if (!localConserved) {
        violations.push(`${id}: local reservation conservation failed`);
      }
      if (localReserved !== active.length) {
        violations.push(`${id}: local reserved ledger does not match active reservations`);
      }
      if (localMaxWindowUsage > state.limit) {
        violations.push(
          `${id}: local window usage ${localMaxWindowUsage} exceeds ${state.limit}`,
        );
      }
      if (!globalConserved) {
        violations.push(`${id}: global reservation conservation failed`);
      }

      const maxWindowUsage = state.ledger.maxUsage();
      if (maxWindowUsage > state.limit) {
        violations.push(
          `${id}: shard window usage ${maxWindowUsage} exceeds ${state.limit}`,
        );
      }
      if (state.violations.length > 0) {
        violations.push(...state.violations);
      }

      const driftMs = state.node.clock.now() - referenceNow;
      if (Math.abs(driftMs) > this.maxClockDriftMs) {
        violations.push(
          `${id}: clock drift ${driftMs}ms exceeds ${this.maxClockDriftMs}ms`,
        );
      }

      nodes.push({
        id,
        shardLimit: state.limit,
        maxWindowUsage,
        localMaxWindowUsage,
        liveReserved,
        passedInLedger: globalPassed,
        accepted: state.accepted,
        committed: state.passed,
        released: state.released,
        pendingEvents: state.node.pendingEvents,
        bufferedEvents: state.buffered.size,
        duplicateEvents: state.duplicateEvents,
        driftMs,
        withinDriftBound: Math.abs(driftMs) <= this.maxClockDriftMs,
        conserved: localConserved && globalConserved,
      });
    }

    const globalMaxWindowUsage = this.#globalLedger.maxUsage();
    if (globalMaxWindowUsage > this.quota) {
      violations.push(
        `global window usage ${globalMaxWindowUsage} exceeds quota ${this.quota}`,
      );
    }
    if (this.totalShardLimit > this.quota) {
      violations.push('total shard limit exceeds global quota');
    }

    return {
      ok: violations.length === 0,
      referenceNow,
      quota: this.quota,
      windowMs: this.windowMs,
      effectiveWindowMs: this.effectiveWindowMs,
      maxClockDriftMs: this.maxClockDriftMs,
      totalShardLimit: this.totalShardLimit,
      globalMaxWindowUsage,
      nodes,
      violations,
      inSync,
    };
  }

  records(): Record<string, WindowRecord[]> {
    const result = Object.create(null) as Record<string, WindowRecord[]>;
    for (const [id, state] of this.#nodes) {
      result[id] = state.ledger.records();
    }
    return result;
  }

  globalRecords(): WindowRecord[] {
    return this.#globalLedger.records();
  }

  usageAt(now = this.referenceClock.now()): number {
    return this.#globalLedger.usageAt(now);
  }

  remainingQuota(now = this.referenceClock.now()): number {
    return Math.max(0, this.quota - this.#globalLedger.usageAt(now));
  }

  close(): void {
    for (const state of this.#nodes.values()) {
      state.node.close();
    }
  }

  #state(id: string): NodeState {
    const state = this.#nodes.get(id);
    if (state === undefined) {
      throw new RangeError(`unknown node: ${id}`);
    }
    return state;
  }

  #apply(
    state: NodeState,
    events: readonly QuotaEvent[],
  ): IngestReport {
    let duplicates = 0;
    const violations: string[] = [];

    for (const event of events) {
      if (event.nodeId !== state.node.id) {
        violations.push(
          `${state.node.id}: event for foreign node ${event.nodeId}`,
        );
        continue;
      }
      if (!Number.isSafeInteger(event.seq) || event.seq <= 0) {
        violations.push(
          `${state.node.id}: invalid event sequence ${event.seq}`,
        );
        continue;
      }
      const kind = (event as { kind: string }).kind;
      if (kind !== 'reserve' && kind !== 'commit' && kind !== 'release') {
        violations.push(
          `${state.node.id}: unknown event kind ${kind} at sequence ${event.seq}`,
        );
        continue;
      }
      if (
        typeof event.reservationId !== 'string' ||
        event.reservationId.length === 0 ||
        event.reservationId.includes('\u0000') ||
        !Number.isFinite(event.at)
      ) {
        violations.push(
          `${state.node.id}: malformed event at sequence ${event.seq}`,
        );
        continue;
      }
      if (event.kind === 'reserve' && !Number.isFinite(event.expiresAt)) {
        violations.push(
          `${state.node.id}: malformed reserve at sequence ${event.seq}`,
        );
        continue;
      }
      if (
        event.kind === 'release' &&
        event.reason !== 'explicit' &&
        event.reason !== 'timeout'
      ) {
        violations.push(
          `${state.node.id}: malformed release at sequence ${event.seq}`,
        );
        continue;
      }
      if (event.seq <= state.lastSeq || state.buffered.has(event.seq)) {
        duplicates += 1;
        state.duplicateEvents += 1;
        continue;
      }
      state.buffered.set(event.seq, event);
    }

    let applied = 0;
    for (;;) {
      const event = state.buffered.get(state.lastSeq + 1);
      if (event === undefined) {
        break;
      }
      state.buffered.delete(event.seq);
      state.lastSeq = event.seq;
      const result = this.#applyOne(state, event);
      applied += result.applied;
      violations.push(...result.violations);
    }

    if (violations.length > 0) {
      state.violations.push(...violations);
    }
    return {
      applied,
      duplicates,
      buffered: state.buffered.size,
      violations,
    };
  }

  #applyOne(
    state: NodeState,
    event: QuotaEvent,
  ): { applied: number; violations: string[] } {
    const violations: string[] = [];
    const globalId = `${state.node.id}\u0000${event.reservationId}`;

    if (event.kind === 'reserve') {
      if (state.ledger.has(event.reservationId) || this.#globalLedger.has(globalId)) {
        violations.push(
          `${state.node.id}: duplicate global reservation ${event.reservationId}`,
        );
        return { applied: 0, violations };
      }
      if (!state.ledger.admit(event.at, state.limit)) {
        violations.push(
          `${state.node.id}: reservation ${event.reservationId} would exceed shard limit`,
        );
        return { applied: 0, violations };
      }
      if (!this.#globalLedger.admit(event.at, this.quota)) {
        violations.push(
          `${state.node.id}: reservation ${event.reservationId} would exceed global quota`,
        );
        return { applied: 0, violations };
      }
      state.ledger.add({
        id: event.reservationId,
        at: event.at,
        state: 'reserved',
      });
      this.#globalLedger.add({
        id: globalId,
        at: event.at,
        state: 'reserved',
      });
      state.accepted += 1;
      return { applied: 1, violations };
    }

    if (event.kind === 'commit') {
      const globalRecord = this.#globalLedger.get(globalId);
      if (globalRecord === undefined || globalRecord.state !== 'reserved') {
        violations.push(
          `${state.node.id}: commit without live global reservation ${event.reservationId}`,
        );
        return { applied: 0, violations };
      }
      if (!state.ledger.commit(event.reservationId)) {
        violations.push(
          `${state.node.id}: commit without live reservation ${event.reservationId}`,
        );
        return { applied: 0, violations };
      }
      this.#globalLedger.commit(globalId);
      state.passed += 1;
      return { applied: 1, violations };
    }

    const record = state.ledger.get(event.reservationId);
    const globalRecord = this.#globalLedger.get(globalId);
    if (
      record === undefined ||
      record.state !== 'reserved' ||
      globalRecord === undefined ||
      globalRecord.state !== 'reserved'
    ) {
      violations.push(
        `${state.node.id}: release without live reservation ${event.reservationId}`,
      );
      return { applied: 0, violations };
    }
    state.ledger.release(event.reservationId);
    this.#globalLedger.release(globalId);
    state.released += 1;
    return { applied: 1, violations };
  }
}

export function createQuotaCluster(options: QuotaClusterOptions): QuotaCoordinator {
  return new QuotaCoordinator(options);
}
