/**
 * In-memory browser lock simulator.
 *
 * - Events carry an integer logical clock; input may arrive out of order and
 *   is applied in clock order (stable for equal clocks).
 * - Lock requests are granted in FIFO order per lock.
 * - A page crash releases every lock it holds and drops its waiting requests.
 * - Recovery of the same page id starts a new generation; messages stamped
 *   with an older generation (e.g. a delayed release) are rejected.
 * - After every applied event the simulator records ownership and verifies
 *   mutual exclusion (at most one holder per lock).
 */

export type EventType = "request" | "release" | "crash" | "recover";

export interface SimEvent {
  /** Integer logical clock of the sender. */
  clock: number;
  type: EventType;
  pageId: string;
  /** Lock name; required for request/release. */
  lock?: string;
  /** Generation the sender believes it is in; required for request/release. */
  generation?: number;
}

export interface Owner {
  pageId: string;
  generation: number;
}

export interface StepRecord {
  index: number;
  event: SimEvent;
  accepted: boolean;
  note: string;
  /** lock name -> owner ("pageId#gen") or null. */
  owners: Record<string, string | null>;
  /** lock name -> waiting "pageId#gen" list, head first. */
  queues: Record<string, string[]>;
}

interface PageState {
  generation: number;
  alive: boolean;
}

interface LockState {
  holder: Owner | null;
  queue: Owner[];
}

function fmt(o: Owner): string {
  return `${o.pageId}#${o.generation}`;
}

export class LockSimulator {
  private pages = new Map<string, PageState>();
  private locks = new Map<string, LockState>();
  readonly history: StepRecord[] = [];

  /**
   * Apply a batch of events. Events may be supplied out of order; they are
   * sorted by logical clock (stable, so equal clocks keep input order).
   */
  run(events: SimEvent[]): StepRecord[] {
    const ordered = events
      .map((event, inputIndex) => ({ event, inputIndex }))
      .sort((a, b) => a.event.clock - b.event.clock || a.inputIndex - b.inputIndex);
    for (const { event } of ordered) this.apply(event);
    return this.history;
  }

  private page(pageId: string): PageState {
    let p = this.pages.get(pageId);
    if (!p) {
      p = { generation: 1, alive: true };
      this.pages.set(pageId, p);
    }
    return p;
  }

  private lock(name: string): LockState {
    let l = this.locks.get(name);
    if (!l) {
      l = { holder: null, queue: [] };
      this.locks.set(name, l);
    }
    return l;
  }

  private apply(event: SimEvent): void {
    let accepted = true;
    let note = "";

    switch (event.type) {
      case "request": {
        const p = this.page(event.pageId);
        const l = this.lock(event.lock!);
        if (!p.alive) {
          accepted = false;
          note = `rejected: page ${event.pageId} is crashed`;
        } else if (event.generation !== p.generation) {
          accepted = false;
          note = `rejected: stale generation ${event.generation} (current ${p.generation})`;
        } else {
          const me: Owner = { pageId: event.pageId, generation: p.generation };
          l.queue.push(me);
          note = `queued ${fmt(me)} on ${event.lock}`;
          this.tryGrant(event.lock!, l);
        }
        break;
      }
      case "release": {
        const p = this.page(event.pageId);
        const l = this.lock(event.lock!);
        if (!p.alive || event.generation !== p.generation) {
          accepted = false;
          note = `rejected: stale release from ${event.pageId}#${event.generation} (current generation ${p.generation})`;
        } else if (!l.holder || l.holder.pageId !== event.pageId || l.holder.generation !== p.generation) {
          accepted = false;
          note = `rejected: ${event.pageId}#${p.generation} does not hold ${event.lock}`;
        } else {
          l.holder = null;
          note = `released ${event.lock} by ${event.pageId}#${p.generation}`;
          this.tryGrant(event.lock!, l);
        }
        break;
      }
      case "crash": {
        const p = this.page(event.pageId);
        p.alive = false;
        const freed: string[] = [];
        for (const [name, l] of this.locks) {
          if (l.holder && l.holder.pageId === event.pageId) {
            l.holder = null;
            freed.push(name);
          }
          const before = l.queue.length;
          l.queue = l.queue.filter((w) => w.pageId !== event.pageId);
          if (l.queue.length !== before) freed.push(`${name}(waitlist)`);
        }
        note = `crash ${event.pageId}#${p.generation}: freed ${freed.length ? freed.join(", ") : "nothing"}`;
        for (const [name, l] of this.locks) this.tryGrant(name, l);
        break;
      }
      case "recover": {
        const p = this.page(event.pageId);
        p.generation += 1;
        p.alive = true;
        note = `recover ${event.pageId}: new generation ${p.generation}`;
        break;
      }
    }

    this.assertMutualExclusion();
    this.history.push({
      index: this.history.length,
      event,
      accepted,
      note,
      owners: this.snapshotOwners(),
      queues: this.snapshotQueues(),
    });
  }

  /** Grant the lock to the head waiter if it is free. */
  private tryGrant(name: string, l: LockState): void {
    while (!l.holder && l.queue.length > 0) {
      const head = l.queue[0];
      const p = this.pages.get(head.pageId);
      if (!p || !p.alive || p.generation !== head.generation) {
        l.queue.shift(); // dead or stale waiter: drop
        continue;
      }
      l.holder = head;
      l.queue.shift();
    }
  }

  private assertMutualExclusion(): void {
    for (const [name, l] of this.locks) {
      if (l.holder && l.queue.some((w) => w.pageId === l.holder!.pageId && w.generation === l.holder!.generation)) {
        throw new Error(`mutual exclusion violated on ${name}: holder also queued`);
      }
    }
  }

  /**
   * Cross-check the whole run: at every step, each lock has at most one
   * holder and the holder is not simultaneously waiting on the same lock.
   */
  verifyMutualExclusion(): boolean {
    for (const step of this.history) {
      for (const [name, owner] of Object.entries(step.owners)) {
        if (owner !== null && step.queues[name]?.includes(owner)) return false;
      }
    }
    return true;
  }

  private snapshotOwners(): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const [name, l] of this.locks) out[name] = l.holder ? fmt(l.holder) : null;
    return out;
  }

  private snapshotQueues(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [name, l] of this.locks) out[name] = l.queue.map(fmt);
    return out;
  }

  /** Human-readable per-step ownership trace. */
  formatHistory(): string {
    return this.history
      .map((s) => {
        const owners = Object.entries(s.owners)
          .map(([k, v]) => `${k}=${v ?? "-"}`)
          .join(" ");
        const queues = Object.entries(s.queues)
          .filter(([, q]) => q.length > 0)
          .map(([k, q]) => `${k}:[${q.join(",")}]`)
          .join(" ");
        const ev = `${s.event.type}(${s.event.pageId}${s.event.lock ? "," + s.event.lock : ""}${s.event.generation !== undefined ? ",gen" + s.event.generation : ""})`;
        return `#${s.index} clock=${s.event.clock} ${ev} -> ${s.accepted ? "OK" : "REJECTED"}: ${s.note} | owners: ${owners}${queues ? " | waiting: " + queues : ""}`;
      })
      .join("\n");
  }
}
