/**
 * 批处理库的输入/输出协议（纯类型声明，不含任何可执行逻辑）。
 *
 * 被测库 (src/batcher.ts) 与独立参考状态机 (oracle/oracle.ts) 都只共享
 * 这些类型，二者互不导入对方的运行时代码，因此参考机的期望结果
 * 完全独立于被测库的实现。
 */

/** 拒绝原因。 */
export type RejectReason =
  | 'backpressure'
  | 'unknown-tenant'
  | 'clock-rewind';

/** 一条写请求的入参。 */
export interface ArrivalInput {
  /** 请求唯一标识（调用方保证全局唯一）。 */
  requestId: string;
  /** 租户标识。 */
  tenantId: string;
  /** 到达时间戳（虚拟时钟，单调不下降）。 */
  at: number;
}

/** 已被批处理库接受的请求（出现在批次或等待队列中）。 */
export interface EnqueuedRequest {
  requestId: string;
  tenantId: string;
  at: number;
  /** 库内全局到达序号（用于同时间戳的确定性排序）。 */
  seq: number;
}

/** 批次生命周期状态。 */
export type BatchStatus =
  | 'open'
  | 'retained'
  | 'in-flight'
  | 'completed';

/** 批次关闭原因。 */
export type CloseReason = 'size' | 'timeout' | 'flush';

/** 一个批次的完整快照。 */
export interface BatchSnapshot {
  batchId: string;
  tenantId: string;
  status: BatchStatus;
  /** 成员按该租户内的入队顺序排列。 */
  members: EnqueuedRequest[];
  /** 批次首个成员的到达时间，也是刷新超时计时起点。 */
  openedAt: number;
  /** open 状态下的超时截止时刻；其余状态为 null。 */
  deadline: number | null;
  /** 关闭时刻与原因；未关闭为 null。 */
  closedAt: number | null;
  closeReason: CloseReason | null;
  /** 派发下游与完成时刻（in-flight/completed 时有值）。 */
  dispatchedAt: number | null;
  completedAt: number | null;
}

/** 单个租户的状态快照。 */
export interface TenantSnapshot {
  tenantId: string;
  quota: number;
  /** 已接受但未完成的请求数（open + retained + in-flight 批次成员之和）。 */
  inFlight: number;
  waiting: EnqueuedRequest[];
  openBatchId: string | null;
  retainedBatchId: string | null;
  inFlightBatchIds: string[];
  completedBatchIds: string[];
}

/** 一个事件处理后产生的拒绝记录。 */
export interface RejectEffect {
  requestId: string | null;
  tenantId: string;
  at: number;
  reason: RejectReason;
}

/** 一个事件处理后发生的批次关闭记录。 */
export interface CloseEffect {
  batchId: string;
  tenantId: string;
  at: number;
  reason: CloseReason;
  members: EnqueuedRequest[];
  /** 关闭后立即派发（非背压）还是整批保留（背压）。 */
  disposition: 'dispatched' | 'retained';
}

/** 背压解除后保留批次的重新派发记录。 */
export interface DispatchEffect {
  batchId: string;
  tenantId: string;
  at: number;
  members: EnqueuedRequest[];
}

/** 批次完成、释放租户配额的记录。 */
export interface CompleteEffect {
  batchId: string;
  tenantId: string;
  at: number;
  members: EnqueuedRequest[];
}

/** 空批/无 open 批次 flush 的边界记录。 */
export interface FlushNoopEffect {
  tenantId: string;
  at: number;
  kind: 'no-open-batch' | 'empty-open-batch';
}

/** 一个事件处理后产生的全部副作用。 */
export interface EventEffects {
  accepted: EnqueuedRequest[];
  rejected: RejectEffect[];
  closed: CloseEffect[];
  retainedDispatched: DispatchEffect[];
  completed: CompleteEffect[];
  flushNoops: FlushNoopEffect[];
}

/** 每个事件处理后的全量差分快照（两台状态机输出必须结构一致）。 */
export interface StateSnapshot {
  now: number;
  backpressure: boolean;
  effects: EventEffects;
  /** 全局等待队列：按 (到达时间, 租户字典序, 全局序号) 排序。 */
  waitingQueue: EnqueuedRequest[];
  tenants: Record<string, TenantSnapshot>;
  /** 全量批次台账，按 batchId 字典序排列。 */
  batches: BatchSnapshot[];
}

/** 带时间戳的输入事件。 */
export type InputEvent =
  | { kind: 'arrival'; arrival: ArrivalInput }
  | { kind: 'flush'; tenantId: string; at: number }
  | { kind: 'backpressure'; on: boolean; at: number }
  | { kind: 'advance'; at: number };

/** 库的静态配置。 */
export interface BatcherConfig {
  /** 批大小：累计条数达到该值立即关闭。 */
  batchSize: number;
  /** 刷新超时：open 批次最早请求等待达到该时长立即关闭。 */
  refreshTimeoutMs: number;
  /** 各租户的独立在途配额。 */
  tenantQuotas: Record<string, number>;
  /** 下游处理耗时：派发到完成的固定时长（确定性测试用）。 */
  downstreamLatencyMs: number;
}
