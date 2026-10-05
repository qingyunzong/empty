import type { RoundMessage } from "./messages.js";

/** Deterministic PRNG (mulberry32) so shuffles are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Simulated unreliable transport: buffers messages and delivers them
 * in an arbitrary (seeded, reproducible) order, possibly long after
 * the producing round has closed.
 */
export class Transport {
  private queue: RoundMessage[] = [];

  send(message: RoundMessage): void {
    this.queue.push(message);
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  pending(): readonly RoundMessage[] {
    return this.queue;
  }

  /** Fisher-Yates shuffle with a seeded PRNG: deterministic out-of-order delivery. */
  shuffle(seed: number): void {
    const rand = mulberry32(seed);
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = this.queue[i]!;
      this.queue[i] = this.queue[j]!;
      this.queue[j] = tmp;
    }
  }

  /** Deliver up to `count` queued messages in current queue order. */
  deliver(count: number, receive: (msg: RoundMessage) => void): RoundMessage[] {
    const batch = this.queue.splice(0, count);
    for (const msg of batch) receive(msg);
    return batch;
  }

  deliverAll(receive: (msg: RoundMessage) => void): RoundMessage[] {
    return this.deliver(this.queue.length, receive);
  }
}
