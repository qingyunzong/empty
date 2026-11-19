import type {
  ArrivalInput,
  BatcherConfig,
  BatchSnapshot,
  BatchStatus,
  CloseReason,
  EnqueuedRequest,
  EventEffects,
  InputEvent,
  StateSnapshot,
  TenantSnapshot,
} from './protocol.js';

interface InternalBatch {
  batchId: string;
  tenantId: string;
  status: BatchStatus;
  members: EnqueuedRequest[];
  openedAt: number;
  deadline: number | null;
  closedAt: number | null;
  closeReason: CloseReason | null;
  dispatchedAt: number | null;
  completedAt: number | null;
  batchSeq: number;
}

interface InternalTenant {
  tenantId: string;
  quota: number;
  openBatch: InternalBatch | null;
  retained: InternalBatch | null;
  inFlightBatches: InternalBatch[];
  completedBatches: InternalBatch[];
  waiting: EnqueuedRequest[];
  nextBatchSeq: number;
}

function emptyEffects(): EventEffects {
  return {
    accepted: [],
    rejected: [],
    closed: [],
    retainedDispatched: [],
    completed: [],
    flushNoops: [],
  };
}

/** 时钟回退等调用方契约错误。 */
export class ProtocolError extends Error {}

/**
 * 多租户确定性批处理库（被测实现）。
 * 所有时间由事件时间戳驱动，内部不持有真实定时器。
 */
export class Batcher {
  private readonly cfg: BatcherConfig;
  private now = 0;
  private backpressureOn = false;
  private globalSeq = 0;
  private readonly tenants = new Map<string, InternalTenant>();
  private readonly batches = new Map<string, InternalBatch>();

  constructor(config: BatcherConfig) {
    this.cfg = config;
    for (const [tenantId, quota] of Object.entries(config.tenantQuotas)) {
      this.tenants.set(tenantId, {
        tenantId,
        quota,
        openBatch: null,
        retained: null,
        inFlightBatches: [],
        completedBatches: [],
        waiting: [],
        nextBatchSeq: 1,
      });
    }
  }

  /** 处理一条带时间戳的输入事件，返回处理后的全量快照。 */
  handle(event: InputEvent): StateSnapshot {
    const effects = emptyEffects();
    const eventTime =
      event.kind === 'arrival' ? event.arrival.at : event.at;
    if (eventTime < this.now) {
      if (event.kind === 'arrival') {
        effects.rejected.push({
          requestId: event.arrival.requestId,
          tenantId: event.arrival.tenantId,
          at: eventTime,
          reason: 'clock-rewind',
        });
        return this.snapshot(effects);
      }
      throw new ProtocolError(
        `event time ${eventTime} is before current time ${this.now}`,
      );
    }
    if (eventTime > this.now) {
      this.settleTime(eventTime, effects);
    }
    switch (event.kind) {
      case 'arrival':
        this.handleArrival(event.arrival, effects);
        break;
      case 'flush':
        this.handleFlush(event.tenantId, eventTime, effects);
        break;
      case 'backpressure':
        if (event.on) {
          this.backpressureOn = true;
        } else {
          this.backpressureOn = false;
          this.dispatchRetained(eventTime, effects);
          this.converge(eventTime, effects);
        }
        break;
      case 'advance':
        break;
    }
    return this.snapshot(effects);
  }

  private inFlightCount(tenant: InternalTenant): number {
    let total = 0;
    if (tenant.openBatch) total += tenant.openBatch.members.length;
    if (tenant.retained) total += tenant.retained.members.length;
    for (const batch of tenant.inFlightBatches) total += batch.members.length;
    return total;
  }

  private settleTime(at: number, effects: EventEffects): void {
    this.now = at;
    const due: InternalBatch[] = [];
    for (const batch of this.batches.values()) {
      if (
        batch.status === 'in-flight' &&
        batch.completedAt !== null &&
        batch.completedAt <= at
      ) {
        due.push(batch);
      }
    }
    due.sort(
      (a, b) =>
        (a.completedAt ?? 0) - (b.completedAt ?? 0) ||
        a.batchId.localeCompare(b.batchId),
    );
    for (const batch of due) {
      this.completeBatch(batch, effects);
    }
    if (!this.backpressureOn) {
      this.converge(at, effects);
    }
  }

  private completeBatch(batch: InternalBatch, effects: EventEffects): void {
    const tenant = this.tenants.get(batch.tenantId)!;
    const index = tenant.inFlightBatches.indexOf(batch);
    tenant.inFlightBatches.splice(index, 1);
    batch.status = 'completed';
    effects.completed.push({
      batchId: batch.batchId,
      tenantId: batch.tenantId,
      at: this.now,
      members: batch.members,
    });
    tenant.completedBatches.push(batch);
  }

  /** 稳态收敛：超时关闭与 FIFO 泵送循环到不再变化。 */
  private converge(at: number, effects: EventEffects): void {
    let changed = true;
    while (changed) {
      changed = false;
      const timedOut: InternalBatch[] = [];
      for (const tenant of this.tenants.values()) {
        const batch = tenant.openBatch;
        if (batch && batch.deadline !== null && batch.deadline <= at) {
          timedOut.push(batch);
        }
      }
      timedOut.sort(
        (a, b) =>
          (a.deadline ?? 0) - (b.deadline ?? 0) ||
          a.batchId.localeCompare(b.batchId),
      );
      for (const batch of timedOut) {
        this.closeBatch(batch, 'timeout', at, effects);
        changed = true;
      }
      if (this.pumpWaiting(at, effects)) changed = true;
    }
  }

  private pumpWaiting(at: number, effects: EventEffects): boolean {
    const head = this.peekWaitingHead();
    if (!head) return false;
    const tenant = this.tenants.get(head.tenantId)!;
    if (this.inFlightCount(tenant) >= tenant.quota) return false;
    this.removeWaitingHead();
    this.admit(tenant, head, at, effects);
    return true;
  }

  private peekWaitingHead(): EnqueuedRequest | null {
    let head: EnqueuedRequest | null = null;
    for (const tenant of this.tenants.values()) {
      const candidate = tenant.waiting[0];
      if (candidate && (!head || this.compareWaiting(candidate, head) < 0)) {
        head = candidate;
      }
    }
    return head;
  }

  private removeWaitingHead(): void {
    let owner: InternalTenant | null = null;
    let head: EnqueuedRequest | null = null;
    for (const tenant of this.tenants.values()) {
      const candidate = tenant.waiting[0];
      if (candidate && (!head || this.compareWaiting(candidate, head) < 0)) {
        head = candidate;
        owner = tenant;
      }
    }
    if (owner && head) {
      owner.waiting.shift();
    }
  }

  private compareWaiting(
    a: EnqueuedRequest,
    b: EnqueuedRequest,
  ): number {
    return (
      a.at - b.at ||
      a.tenantId.localeCompare(b.tenantId) ||
      a.seq - b.seq
    );
  }

  private handleArrival(
    arrival: ArrivalInput,
    effects: EventEffects,
  ): void {
    const tenant = this.tenants.get(arrival.tenantId);
    if (!tenant) {
      effects.rejected.push({
        requestId: arrival.requestId,
        tenantId: arrival.tenantId,
        at: arrival.at,
        reason: 'unknown-tenant',
      });
      return;
    }
    if (this.backpressureOn) {
      effects.rejected.push({
        requestId: arrival.requestId,
        tenantId: arrival.tenantId,
        at: arrival.at,
        reason: 'backpressure',
      });
      return;
    }
    const request = this.enqueue(arrival);
    if (this.inFlightCount(tenant) >= tenant.quota) {
      tenant.waiting.push(request);
      return;
    }
    this.admit(tenant, request, arrival.at, effects);
  }

  private enqueue(arrival: ArrivalInput): EnqueuedRequest {
    this.globalSeq += 1;
    return {
      requestId: arrival.requestId,
      tenantId: arrival.tenantId,
      at: arrival.at,
      seq: this.globalSeq,
    };
  }

  private admit(
    tenant: InternalTenant,
    request: EnqueuedRequest,
    at: number,
    effects: EventEffects,
  ): void {
    effects.accepted.push(request);
    const existing = tenant.openBatch;
    const batch = existing ?? this.openBatch(tenant, request, at);
    if (existing) {
      batch.members.push(request);
    }
    if (batch.members.length >= this.cfg.batchSize) {
      this.closeBatch(batch, 'size', at, effects);
    }
  }

  private openBatch(
    tenant: InternalTenant,
    first: EnqueuedRequest,
    at: number,
  ): InternalBatch {
    const batchSeq = tenant.nextBatchSeq;
    tenant.nextBatchSeq += 1;
    const batch: InternalBatch = {
      batchId: `${tenant.tenantId}#${batchSeq}`,
      tenantId: tenant.tenantId,
      status: 'open',
      members: [first],
      openedAt: at,
      deadline: at + this.cfg.refreshTimeoutMs,
      closedAt: null,
      closeReason: null,
      dispatchedAt: null,
      completedAt: null,
      batchSeq,
    };
    tenant.openBatch = batch;
    this.batches.set(batch.batchId, batch);
    return batch;
  }

  private closeBatch(
    batch: InternalBatch,
    reason: CloseReason,
    at: number,
    effects: EventEffects,
  ): void {
    const tenant = this.tenants.get(batch.tenantId)!;
    batch.closedAt = at;
    batch.closeReason = reason;
    batch.deadline = null;
    tenant.openBatch = null;
    if (this.backpressureOn) {
      batch.status = 'retained';
      tenant.retained = batch;
    } else {
      this.dispatch(batch, at);
    }
    effects.closed.push({
      batchId: batch.batchId,
      tenantId: batch.tenantId,
      at,
      reason,
      members: batch.members,
      disposition: this.backpressureOn ? 'retained' : 'dispatched',
    });
  }

  private dispatch(batch: InternalBatch, at: number): void {
    const tenant = this.tenants.get(batch.tenantId)!;
    batch.status = 'in-flight';
    batch.dispatchedAt = at;
    batch.completedAt = at + this.cfg.downstreamLatencyMs;
    tenant.inFlightBatches.push(batch);
  }

  private dispatchRetained(at: number, effects: EventEffects): void {
    const tenantIds = [...this.tenants.keys()].sort();
    for (const tenantId of tenantIds) {
      const tenant = this.tenants.get(tenantId)!;
      const retained = tenant.retained;
      if (retained) {
        tenant.retained = null;
        this.dispatch(retained, at);
        effects.retainedDispatched.push({
          batchId: retained.batchId,
          tenantId,
          at,
          members: retained.members,
        });
      }
    }
  }

  private handleFlush(
    tenantId: string,
    at: number,
    effects: EventEffects,
  ): void {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) {
      throw new ProtocolError(`flush for unknown tenant ${tenantId}`);
    }
    const batch = tenant.openBatch;
    if (!batch) {
      effects.flushNoops.push({
        tenantId,
        at,
        kind: 'no-open-batch',
      });
      return;
    }
    if (batch.members.length === 0) {
      effects.flushNoops.push({
        tenantId,
        at,
        kind: 'empty-open-batch',
      });
      return;
    }
    this.closeBatch(batch, 'flush', at, effects);
    if (!this.backpressureOn) {
      this.converge(at, effects);
    }
  }

  private snapshot(effects: EventEffects): StateSnapshot {
    const tenants: Record<string, TenantSnapshot> = {};
    const waitingQueue: EnqueuedRequest[] = [];
    for (const tenantId of [...this.tenants.keys()].sort()) {
      const tenant = this.tenants.get(tenantId)!;
      const waiting = [...tenant.waiting].sort((a, b) =>
        this.compareWaiting(a, b),
      );
      waitingQueue.push(...waiting);
      tenants[tenantId] = {
        tenantId,
        quota: tenant.quota,
        inFlight: this.inFlightCount(tenant),
        waiting,
        openBatchId: tenant.openBatch?.batchId ?? null,
        retainedBatchId: tenant.retained?.batchId ?? null,
        inFlightBatchIds: tenant.inFlightBatches.map((batch) => batch.batchId),
        completedBatchIds: tenant.completedBatches.map(
          (batch) => batch.batchId,
        ),
      };
    }
    waitingQueue.sort((a, b) => this.compareWaiting(a, b));
    const batches: BatchSnapshot[] = [...this.batches.values()]
      .sort((a, b) => a.batchId.localeCompare(b.batchId))
      .map((batch) => ({
        batchId: batch.batchId,
        tenantId: batch.tenantId,
        status: batch.status,
        members: batch.members,
        openedAt: batch.openedAt,
        deadline: batch.deadline,
        closedAt: batch.closedAt,
        closeReason: batch.closeReason,
        dispatchedAt: batch.dispatchedAt,
        completedAt: batch.completedAt,
      }));
    return {
      now: this.now,
      backpressure: this.backpressureOn,
      effects,
      waitingQueue,
      tenants,
      batches,
    };
  }
}
