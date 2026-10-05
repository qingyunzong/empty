import { randomUUID } from "node:crypto";

export interface Message {
  id: string;
  topic: string;
  payload: unknown;
}

export interface Delivery {
  id: string;
  payload: unknown;
  /** 1-based delivery attempt counter for this subscription. */
  attempt: number;
  leaseId: string;
}

export interface FetchResult {
  /** Generation the returned leases belong to. ACKs must quote it. */
  generation: number;
  deliveries: Delivery[];
}

export interface AckResult {
  acked: string[];
  /** Stale-generation or unknown ids land here and stay eligible for redelivery. */
  rejected: string[];
}

interface InFlight {
  generation: number;
  leaseId: string;
  expiresAt: number;
}

class SubscriptionState {
  generation = 1;
  available: string[] = [];
  inFlight = new Map<string, InFlight>();
  attempts = new Map<string, number>();
}

interface Subscription {
  topic: string;
  state: SubscriptionState;
}

export class BrokerError extends Error {}

/**
 * In-memory broker with lease-based fetch, generation-scoped ACK and
 * lease-expiry redelivery (at-least-once). Time is advanced manually via
 * `advance()` so tests are deterministic.
 */
export class Broker {
  private messages = new Map<string, Message>();
  private topics = new Map<string, string[]>();
  private subs = new Map<string, Subscription>();
  private now = 0;
  readonly leaseMs: number;

  /** Fault injection hook: throw to simulate a broker-side ACK failure. */
  beforeAck: ((messageId: string) => void) | null = null;

  constructor(opts: { leaseMs?: number } = {}) {
    this.leaseMs = opts.leaseMs ?? 1000;
  }

  advance(ms: number): void {
    this.now += ms;
  }

  publish(topic: string, payload: unknown, id?: string): string {
    const messageId = id ?? randomUUID();
    this.messages.set(messageId, { id: messageId, topic, payload });
    let ids = this.topics.get(topic);
    if (!ids) {
      ids = [];
      this.topics.set(topic, ids);
    }
    ids.push(messageId);
    for (const sub of this.subs.values()) {
      if (sub.topic === topic) sub.state.available.push(messageId);
    }
    return messageId;
  }

  subscribe(topic: string): string {
    const subId = randomUUID();
    const state = new SubscriptionState();
    state.available.push(...(this.topics.get(topic) ?? []));
    this.subs.set(subId, { topic, state });
    return subId;
  }

  /**
   * Subscription generation change (e.g. rebalance / reconnect): outstanding
   * leases are recalled and every ACK quoting the old generation is rejected.
   */
  resubscribe(subId: string): number {
    const sub = this.mustSub(subId);
    for (const id of sub.state.inFlight.keys()) sub.state.available.push(id);
    sub.state.inFlight.clear();
    sub.state.generation += 1;
    return sub.state.generation;
  }

  fetch(subId: string, max: number): FetchResult {
    const sub = this.mustSub(subId);
    this.sweepExpired(sub.state);
    const deliveries: Delivery[] = [];
    while (deliveries.length < max && sub.state.available.length > 0) {
      const id = sub.state.available.shift() as string;
      const msg = this.messages.get(id) as Message;
      const attempt = (sub.state.attempts.get(id) ?? 0) + 1;
      sub.state.attempts.set(id, attempt);
      const lease: InFlight = {
        generation: sub.state.generation,
        leaseId: randomUUID(),
        expiresAt: this.now + this.leaseMs,
      };
      sub.state.inFlight.set(id, lease);
      deliveries.push({ id, payload: msg.payload, attempt, leaseId: lease.leaseId });
    }
    return { generation: sub.state.generation, deliveries };
  }

  ack(subId: string, generation: number, messageIds: string[]): AckResult {
    const sub = this.mustSub(subId);
    const acked: string[] = [];
    const rejected: string[] = [];
    for (const id of messageIds) {
      const lease = sub.state.inFlight.get(id);
      if (generation !== sub.state.generation || !lease || lease.generation !== generation) {
        rejected.push(id);
        continue;
      }
      if (this.beforeAck) this.beforeAck(id); // injected fault: throws, lease survives
      sub.state.inFlight.delete(id);
      sub.state.attempts.delete(id);
      acked.push(id);
    }
    return { acked, rejected };
  }

  private sweepExpired(state: SubscriptionState): void {
    for (const [id, lease] of state.inFlight) {
      if (lease.expiresAt <= this.now) {
        state.inFlight.delete(id);
        state.available.push(id);
      }
    }
  }

  private mustSub(subId: string): Subscription {
    const sub = this.subs.get(subId);
    if (!sub) throw new BrokerError(`unknown subscription ${subId}`);
    return sub;
  }
}
