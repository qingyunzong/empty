/**
 * Plan-controlled deterministic scheduler.
 *
 * Every promise handed to an implementation under test resolves only when the
 * runner advances the scheduler (`tick`). Settlement delays and ordering are
 * drawn from a seeded PRNG stream, so an entire run — including all async
 * behaviour — is fully determined by (ops, plan).
 */

export interface Plan {
  /** Seed for the deterministic delay stream. */
  seed: number;
  /** Maximum settlement delay in ticks (minimum is 1). */
  maxDelay: number;
}

/** mulberry32: small, fast, deterministic PRNG. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Pending {
  due: number;
  seq: number;
  fire: () => void;
}

export class PlanScheduler {
  private readonly rand: () => number;
  private queue: Pending[] = [];
  private seq = 0;
  /** Current logical time in ticks. */
  now = 0;

  constructor(readonly plan: Plan) {
    this.rand = mulberry32(plan.seed);
  }

  /**
   * Schedule a settlement. The delay (in ticks) is drawn from the plan's
   * deterministic stream; callers never observe real time.
   */
  schedule<T>(value: T): Promise<T> {
    const delay = 1 + Math.floor(this.rand() * this.plan.maxDelay);
    return this.scheduleIn(delay, value);
  }

  /** Schedule a settlement with an explicit delay. */
  scheduleIn<T>(delay: number, value: T): Promise<T> {
    const due = this.now + Math.max(1, delay);
    const seq = this.seq++;
    return new Promise<T>((resolve) => {
      this.queue.push({ due, seq, fire: () => resolve(value) });
    });
  }

  /** Advance logical time by one tick, settling everything that is due. */
  advance(): void {
    this.now += 1;
    const ready = this.queue
      .filter((p) => p.due <= this.now)
      .sort((a, b) => a.seq - b.seq);
    this.queue = this.queue.filter((p) => p.due > this.now);
    for (const p of ready) p.fire();
  }

  /** Number of scheduled settlements that have not fired yet. */
  get pending(): number {
    return this.queue.length;
  }
}

/** Drain the microtask queue so settled promises run their continuations. */
export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
