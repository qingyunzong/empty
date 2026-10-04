import type { AckResult, Broker, Delivery } from "./broker.js";
import { CommitError, type DedupStore } from "./store.js";
import type { TraceLog } from "./trace.js";

export type PollOutcome =
  | "empty"
  | "broker-down"
  | "processed"
  | "duplicate-suppressed"
  | "commit-failed";

/** 故障注入钩子：在投递处理的关键时点插入代理侧故障。 */
export interface ConsumerHooks {
  /** 业务事务已提交、ACK 尚未发出（可在此刻让代理崩溃）。 */
  beforeAck?: (delivery: Delivery) => void;
  afterAck?: (delivery: Delivery, result: AckResult) => void;
}

/**
 * 处理端：至少一次投递 + ID 事务去重 = 业务效果恰好一次。
 * - 已处理 ID 直接抑制业务效果，但仍补 ACK 让代理停止重投；
 * - 事务提交失败不 ACK，等租约过期重投后重试；
 * - ACK 失败（代理故障 / 世代过期）由重投 + 去重兜底。
 */
export class Consumer {
  constructor(
    private readonly broker: Broker,
    private readonly store: DedupStore,
    private readonly trace: TraceLog,
    private readonly subscriptionId: string,
    private readonly hooks: ConsumerHooks = {},
  ) {}

  pollOnce(): PollOutcome {
    const delivery = this.broker.pull(this.subscriptionId);
    if (!delivery) {
      return this.broker.isDown() ? "broker-down" : "empty";
    }
    const id = delivery.message.id;
    this.trace.record("consumer", "delivered", {
      id,
      deliveryId: delivery.deliveryId,
      attempt: delivery.attempt,
      generation: delivery.generation,
    });

    if (this.store.has(id)) {
      this.trace.record("consumer", "duplicate-suppressed", { id, attempt: delivery.attempt });
      this.broker.ack(delivery);
      return "duplicate-suppressed";
    }

    try {
      this.store.applyEffect(id, `effect:${delivery.message.payload}`);
    } catch (err) {
      if (err instanceof CommitError) {
        this.trace.record("consumer", "commit-failed-no-ack", { id, attempt: delivery.attempt });
        return "commit-failed";
      }
      throw err;
    }

    this.hooks.beforeAck?.(delivery);
    const result = this.broker.ack(delivery);
    if (!result.ok) {
      this.trace.record("consumer", "ack-failed", {
        id,
        attempt: delivery.attempt,
        reason: result.reason,
      });
    }
    this.hooks.afterAck?.(delivery, result);
    return "processed";
  }
}
