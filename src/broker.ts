import type { TraceLog } from "./trace.js";

export interface Message {
  id: string;
  payload: string;
}

/** 一次租约投递凭证：处理端凭 deliveryId + generation 回 ACK。 */
export interface Delivery {
  deliveryId: string;
  subscriptionId: string;
  generation: number;
  message: Message;
  /** 第几次投递（1 为首次，>1 为重投）。 */
  attempt: number;
  leaseExpiresAt: number;
}

export type AckRejection = "stale-generation" | "unknown-lease" | "broker-unavailable";

export type AckResult = { ok: true } | { ok: false; reason: AckRejection };

type EntryState = "available" | "leased" | "acked";

interface Entry {
  message: Message;
  state: EntryState;
  attempt: number;
  deliveryId: string | null;
  leaseExpiresAt: number;
}

/**
 * 模拟消息代理（至少一次语义）：
 * - pull 以租约形式发放消息，租约过期未 ACK 自动重回队列重投；
 * - 每个订阅有世代号（generation），崩溃重启 / 重新订阅后世代 +1；
 * - ACK 必须携带当前世代，旧世代 ACK 一律拒绝（stale-generation）；
 * - crash({ loseAcked: true }) 模拟已确认状态丢失，已 ACK 消息也会被重投。
 */
export class Broker {
  private readonly entries = new Map<string, Entry>();
  private readonly order: string[] = [];
  private readonly generations = new Map<string, number>();
  private readonly leaseOwners = new Map<string, string>(); // deliveryId -> messageId
  private deliverySeq = 0;
  private down = false;

  constructor(
    private readonly trace: TraceLog,
    private readonly now: () => number,
    readonly leaseMs = 1000,
  ) {}

  subscribe(subscriptionId: string): number {
    const generation = (this.generations.get(subscriptionId) ?? 0) + 1;
    this.generations.set(subscriptionId, generation);
    this.trace.record("broker", "subscribed", { subscriptionId, generation });
    return generation;
  }

  generationOf(subscriptionId: string): number {
    return this.generations.get(subscriptionId) ?? 0;
  }

  publish(message: Message): void {
    if (this.entries.has(message.id)) {
      throw new Error(`duplicate message id: ${message.id}`);
    }
    this.entries.set(message.id, {
      message,
      state: "available",
      attempt: 0,
      deliveryId: null,
      leaseExpiresAt: 0,
    });
    this.order.push(message.id);
    this.trace.record("broker", "published", { id: message.id });
  }

  /** 领取一条消息（带租约）。返回 null 表示当前无可投递消息。 */
  pull(subscriptionId: string): Delivery | null {
    if (this.down) {
      this.trace.record("broker", "pull-while-down", { subscriptionId });
      return null;
    }
    this.expireLeases();
    const generation = this.generationOf(subscriptionId);
    for (const id of this.order) {
      const entry = this.entries.get(id);
      if (!entry || entry.state !== "available") continue;
      entry.state = "leased";
      entry.attempt += 1;
      entry.deliveryId = `lease-${++this.deliverySeq}`;
      entry.leaseExpiresAt = this.now() + this.leaseMs;
      this.leaseOwners.set(entry.deliveryId, id);
      this.trace.record("broker", entry.attempt === 1 ? "leased" : "redelivered", {
        id,
        deliveryId: entry.deliveryId,
        attempt: entry.attempt,
        generation,
        leaseExpiresAt: entry.leaseExpiresAt,
      });
      return {
        deliveryId: entry.deliveryId,
        subscriptionId,
        generation,
        message: entry.message,
        attempt: entry.attempt,
        leaseExpiresAt: entry.leaseExpiresAt,
      };
    }
    return null;
  }

  ack(delivery: Pick<Delivery, "deliveryId" | "subscriptionId" | "generation">): AckResult {
    if (this.down) {
      this.trace.record("broker", "ack-rejected", {
        deliveryId: delivery.deliveryId,
        reason: "broker-unavailable",
      });
      return { ok: false, reason: "broker-unavailable" };
    }
    const current = this.generationOf(delivery.subscriptionId);
    if (delivery.generation !== current) {
      this.trace.record("broker", "ack-rejected", {
        deliveryId: delivery.deliveryId,
        reason: "stale-generation",
        ackGeneration: delivery.generation,
        currentGeneration: current,
      });
      return { ok: false, reason: "stale-generation" };
    }
    const id = this.leaseOwners.get(delivery.deliveryId);
    const entry = id === undefined ? undefined : this.entries.get(id);
    if (!entry || entry.state !== "leased" || entry.deliveryId !== delivery.deliveryId) {
      this.trace.record("broker", "ack-rejected", {
        deliveryId: delivery.deliveryId,
        reason: "unknown-lease",
      });
      return { ok: false, reason: "unknown-lease" };
    }
    entry.state = "acked";
    entry.deliveryId = null;
    this.leaseOwners.delete(delivery.deliveryId);
    this.trace.record("broker", "ack-accepted", {
      id,
      deliveryId: delivery.deliveryId,
      generation: delivery.generation,
    });
    return { ok: true };
  }

  /** 故障注入：代理崩溃重启。在飞租约全部丢失，所有订阅世代 +1。 */
  crash(options: { loseAcked?: boolean } = {}): void {
    for (const [sub, gen] of this.generations) {
      this.generations.set(sub, gen + 1);
    }
    let lostLeases = 0;
    let lostAcks = 0;
    for (const id of this.order) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      if (entry.state === "leased") {
        entry.state = "available";
        lostLeases += 1;
      } else if (entry.state === "acked" && options.loseAcked) {
        entry.state = "available";
        lostAcks += 1;
      }
      if (entry.deliveryId !== null) {
        this.leaseOwners.delete(entry.deliveryId);
        entry.deliveryId = null;
      }
    }
    this.trace.record("broker", "broker-crash", {
      lostLeases,
      lostAcks,
      generations: Object.fromEntries(this.generations),
    });
  }

  /** 故障注入：代理临时不可用（ACK/pull 直接失败）。 */
  setDown(down: boolean): void {
    this.down = down;
    this.trace.record("broker", down ? "broker-down" : "broker-up", {});
  }

  isDown(): boolean {
    return this.down;
  }

  /** 尚未被确认的消息数（available + leased）。 */
  pendingCount(): number {
    let n = 0;
    for (const entry of this.entries.values()) {
      if (entry.state !== "acked") n += 1;
    }
    return n;
  }

  private expireLeases(): void {
    const t = this.now();
    for (const id of this.order) {
      const entry = this.entries.get(id);
      if (!entry || entry.state !== "leased" || entry.leaseExpiresAt > t) continue;
      entry.state = "available";
      this.trace.record("broker", "lease-expired", {
        id,
        deliveryId: entry.deliveryId,
        attempt: entry.attempt,
      });
      if (entry.deliveryId !== null) {
        this.leaseOwners.delete(entry.deliveryId);
        entry.deliveryId = null;
      }
    }
  }
}
