/**
 * 独立参考状态机（oracle）。
 *
 * 与 src/batcher.ts 完全独立：不导入其任何运行时代码，只共享 protocol.ts
 * 的类型声明。实现刻意采用函数式不可变 reducer 风格（每次转移返回新状态），
 * 内部数据结构（按状态分桶的记录集合）也与被测库的类+引用结构不同。
 * 测试中的期望输出全部由本文件生成。
 */
import type {
  BatcherConfig,
  EnqueuedRequest,
  EventEffects,
  InputEvent,
  StateSnapshot,
} from '../src/protocol.js';

interface OracleBatch {
  batchId: string;
  tenantId: string;
  status: 'open' | 'retained' | 'in-flight' | 'completed';
  members: EnqueuedRequest[];
  openedAt: number;
  deadline: number | null;
  closedAt: number | null;
  closeReason: 'size' | 'timeout' | 'flush' | null;
  dispatchedAt: number | null;
  completedAt: number | null;
}

interface OracleTenant {
  tenantId: string;
  quota: number;
  waiting: EnqueuedRequest[];
  openBatchId: string | null;
  retainedBatchId: string | null;
  inFlightBatchIds: string[];
  completedBatchIds: string[];
  nextBatchSeq: number;
}

interface OracleState {
  now: number;
  backpressure: boolean;
  nextSeq: number;
  tenants: Record<string, OracleTenant>;
  batches: Record<string, OracleBatch>;
}

function blankEffects(): EventEffects {
  return {
    accepted: [],
    rejected: [],
    closed: [],
    retainedDispatched: [],
    completed: [],
    flushNoops: [],
  };
}

export class OracleProtocolError extends Error {}

export function initOracle(config: BatcherConfig): OracleState {
  const tenants: Record<string, OracleTenant> = {};
  for (const [tenantId, quota] of Object.entries(config.tenantQuotas)) {
    tenants[tenantId] = {
      tenantId,
      quota,
      waiting: [],
      openBatchId: null,
      retainedBatchId: null,
      inFlightBatchIds: [],
      completedBatchIds: [],
      nextBatchSeq: 1,
    };
  }
  return { now: 0, backpressure: false, nextSeq: 0, tenants, batches: {} };
}

function rank(req: EnqueuedRequest): [number, string, number] {
  return [req.at, req.tenantId, req.seq];
}

function compareRank(a: EnqueuedRequest, b: EnqueuedRequest): number {
  const [at1, t1, s1] = rank(a);
  const [at2, t2, s2] = rank(b);
  return at1 - at2 || t1.localeCompare(t2) || s1 - s2;
}

function inFlightOf(state: OracleState, tenantId: string): number {
  const tenant = state.tenants[tenantId]!;
  const open = tenant.openBatchId
    ? state.batches[tenant.openBatchId]!.members.length
    : 0;
  const retained = tenant.retainedBatchId
    ? state.batches[tenant.retainedBatchId]!.members.length
    : 0;
  const flying = tenant.inFlightBatchIds.reduce(
    (sum, id) => sum + state.batches[id]!.members.length,
    0,
  );
  return open + retained + flying;
}

function globalHead(state: OracleState): EnqueuedRequest | null {
  const heads = Object.values(state.tenants)
    .map((tenant) => tenant.waiting[0])
    .filter((req): req is EnqueuedRequest => req !== undefined);
  if (heads.length === 0) return null;
  return heads.reduce((best, req) =>
    compareRank(req, best) < 0 ? req : best,
  );
}

function makeBatch(
  state: OracleState,
  tenant: OracleTenant,
  first: EnqueuedRequest,
  config: BatcherConfig,
): OracleBatch {
  const seq = tenant.nextBatchSeq;
  tenant.nextBatchSeq += 1;
  const batchId = `${tenant.tenantId}#${seq}`;
  const batch: OracleBatch = {
    batchId,
    tenantId: tenant.tenantId,
    status: 'open',
    members: [first],
    openedAt: state.now,
    deadline: state.now + config.refreshTimeoutMs,
    closedAt: null,
    closeReason: null,
    dispatchedAt: null,
    completedAt: null,
  };
  state.batches[batchId] = batch;
  tenant.openBatchId = batchId;
  return batch;
}

function closeBatch(
  state: OracleState,
  batch: OracleBatch,
  reason: 'size' | 'timeout' | 'flush',
  effects: EventEffects,
  config: BatcherConfig,
): void {
  const tenant = state.tenants[batch.tenantId]!;
  batch.closedAt = state.now;
  batch.closeReason = reason;
  batch.deadline = null;
  tenant.openBatchId = null;
  if (state.backpressure) {
    batch.status = 'retained';
    tenant.retainedBatchId = batch.batchId;
  } else {
    batch.status = 'in-flight';
    batch.dispatchedAt = state.now;
    batch.completedAt = state.now + config.downstreamLatencyMs;
    tenant.inFlightBatchIds.push(batch.batchId);
  }
  effects.closed.push({
    batchId: batch.batchId,
    tenantId: batch.tenantId,
    at: state.now,
    reason,
    members: batch.members,
    disposition: state.backpressure ? 'retained' : 'dispatched',
  });
}

function admit(
  state: OracleState,
  tenant: OracleTenant,
  request: EnqueuedRequest,
  effects: EventEffects,
  config: BatcherConfig,
): void {
  effects.accepted.push(request);
  const existingBatchId = tenant.openBatchId;
  const batch = existingBatchId
    ? state.batches[existingBatchId]!
    : makeBatch(state, tenant, request, config);
  if (existingBatchId) {
    batch.members.push(request);
  }
  if (batch.members.length >= config.batchSize) {
    closeBatch(state, batch, 'size', effects, config);
  }
}

function pumpOnce(
  state: OracleState,
  effects: EventEffects,
  config: BatcherConfig,
): boolean {
  const head = globalHead(state);
  if (!head) return false;
  const tenant = state.tenants[head.tenantId]!;
  if (inFlightOf(state, head.tenantId) >= tenant.quota) return false;
  tenant.waiting.shift();
  admit(state, tenant, head, effects, config);
  return true;
}

function converge(
  state: OracleState,
  effects: EventEffects,
  config: BatcherConfig,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    const expired = Object.values(state.batches)
      .filter(
        (batch) =>
          batch.status === 'open' &&
          batch.deadline !== null &&
          batch.deadline <= state.now,
      )
      .sort(
        (a, b) =>
          (a.deadline ?? 0) - (b.deadline ?? 0) ||
          a.batchId.localeCompare(b.batchId),
      );
    for (const batch of expired) {
      closeBatch(state, batch, 'timeout', effects, config);
      changed = true;
    }
    if (pumpOnce(state, effects, config)) changed = true;
  }
}

function settle(
  state: OracleState,
  at: number,
  effects: EventEffects,
  config: BatcherConfig,
): void {
  state.now = at;
  const finishing = Object.values(state.batches)
    .filter(
      (batch) =>
        batch.status === 'in-flight' &&
        batch.completedAt !== null &&
        batch.completedAt <= at,
    )
    .sort(
      (a, b) =>
        (a.completedAt ?? 0) - (b.completedAt ?? 0) ||
        a.batchId.localeCompare(b.batchId),
    );
  for (const batch of finishing) {
    const tenant = state.tenants[batch.tenantId]!;
    tenant.inFlightBatchIds = tenant.inFlightBatchIds.filter(
      (id) => id !== batch.batchId,
    );
    batch.status = 'completed';
    tenant.completedBatchIds.push(batch.batchId);
    effects.completed.push({
      batchId: batch.batchId,
      tenantId: batch.tenantId,
      at: state.now,
      members: batch.members,
    });
  }
  if (!state.backpressure) {
    converge(state, effects, config);
  }
}

function handleArrival(
  state: OracleState,
  event: Extract<InputEvent, { kind: 'arrival' }>,
  effects: EventEffects,
  config: BatcherConfig,
): void {
  const { arrival } = event;
  const tenant = state.tenants[arrival.tenantId];
  if (!tenant) {
    effects.rejected.push({
      requestId: arrival.requestId,
      tenantId: arrival.tenantId,
      at: arrival.at,
      reason: 'unknown-tenant',
    });
    return;
  }
  if (state.backpressure) {
    effects.rejected.push({
      requestId: arrival.requestId,
      tenantId: arrival.tenantId,
      at: arrival.at,
      reason: 'backpressure',
    });
    return;
  }
  state.nextSeq += 1;
  const request: EnqueuedRequest = {
    requestId: arrival.requestId,
    tenantId: arrival.tenantId,
    at: arrival.at,
    seq: state.nextSeq,
  };
  if (inFlightOf(state, tenant.tenantId) >= tenant.quota) {
    tenant.waiting.push(request);
    return;
  }
  admit(state, tenant, request, effects, config);
}

function handleFlush(
  state: OracleState,
  event: Extract<InputEvent, { kind: 'flush' }>,
  effects: EventEffects,
  config: BatcherConfig,
): void {
  const tenant = state.tenants[event.tenantId];
  if (!tenant) {
    throw new OracleProtocolError(`flush for unknown tenant ${event.tenantId}`);
  }
  if (!tenant.openBatchId) {
    effects.flushNoops.push({
      tenantId: event.tenantId,
      at: event.at,
      kind: 'no-open-batch',
    });
    return;
  }
  const batch = state.batches[tenant.openBatchId]!;
  if (batch.members.length === 0) {
    effects.flushNoops.push({
      tenantId: event.tenantId,
      at: event.at,
      kind: 'empty-open-batch',
    });
    return;
  }
  closeBatch(state, batch, 'flush', effects, config);
  if (!state.backpressure) {
    converge(state, effects, config);
  }
}

function handleBackpressureOff(
  state: OracleState,
  at: number,
  effects: EventEffects,
  config: BatcherConfig,
): void {
  state.backpressure = false;
  for (const tenantId of Object.keys(state.tenants).sort()) {
    const tenant = state.tenants[tenantId]!;
    const retainedId = tenant.retainedBatchId;
    if (!retainedId) continue;
    const batch = state.batches[retainedId]!;
    tenant.retainedBatchId = null;
    batch.status = 'in-flight';
    batch.dispatchedAt = at;
    batch.completedAt = at + config.downstreamLatencyMs;
    tenant.inFlightBatchIds.push(batch.batchId);
    effects.retainedDispatched.push({
      batchId: batch.batchId,
      tenantId,
      at,
      members: batch.members,
    });
  }
  converge(state, effects, config);
}

/** 参考机的单事件转移：返回处理后的全量快照（即测试的期望输出）。 */
export function oracleStep(
  state: OracleState,
  event: InputEvent,
  config: BatcherConfig,
): StateSnapshot {
  const effects = blankEffects();
  const eventTime =
    event.kind === 'arrival' ? event.arrival.at : event.at;
  if (eventTime < state.now) {
    if (event.kind === 'arrival') {
      effects.rejected.push({
        requestId: event.arrival.requestId,
        tenantId: event.arrival.tenantId,
        at: eventTime,
        reason: 'clock-rewind',
      });
      return render(state, effects);
    }
    throw new OracleProtocolError(
      `event time ${eventTime} is before current time ${state.now}`,
    );
  }
  if (eventTime > state.now) {
    settle(state, eventTime, effects, config);
  }
  switch (event.kind) {
    case 'arrival':
      handleArrival(state, event, effects, config);
      break;
    case 'flush':
      handleFlush(state, event, effects, config);
      break;
    case 'backpressure':
      if (event.on) {
        state.backpressure = true;
      } else {
        handleBackpressureOff(state, eventTime, effects, config);
      }
      break;
    case 'advance':
      break;
  }
  return render(state, effects);
}

function render(state: OracleState, effects: EventEffects): StateSnapshot {
  const tenants: StateSnapshot['tenants'] = {};
  const waitingQueue: EnqueuedRequest[] = [];
  for (const tenantId of Object.keys(state.tenants).sort()) {
    const tenant = state.tenants[tenantId]!;
    const waiting = [...tenant.waiting].sort(compareRank);
    waitingQueue.push(...waiting);
    tenants[tenantId] = {
      tenantId,
      quota: tenant.quota,
      inFlight: inFlightOf(state, tenantId),
      waiting,
      openBatchId: tenant.openBatchId,
      retainedBatchId: tenant.retainedBatchId,
      inFlightBatchIds: [...tenant.inFlightBatchIds],
      completedBatchIds: [...tenant.completedBatchIds],
    };
  }
  waitingQueue.sort(compareRank);
  const batches = Object.values(state.batches)
    .sort((a, b) => a.batchId.localeCompare(b.batchId))
    .map((batch) => ({ ...batch, members: [...batch.members] }));
  return {
    now: state.now,
    backpressure: state.backpressure,
    effects,
    waitingQueue,
    tenants,
    batches,
  };
}
