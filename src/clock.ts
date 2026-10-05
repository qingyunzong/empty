export type TimerId = number;

interface ClockEvent {
  id: TimerId;
  time: number;
  seq: number;
  cb: () => void;
  cancelled: boolean;
}

/**
 * Deterministic virtual clock. Events fire in (time, seq) order, so two
 * events landing on the same tick are decided by scheduling order.
 */
export class VirtualClock {
  private _now = 0;
  private seq = 0;
  private nextId = 1;
  private readonly queue: ClockEvent[] = [];
  private readonly byId = new Map<TimerId, ClockEvent>();

  get now(): number {
    return this._now;
  }

  get pendingCount(): number {
    return this.byId.size;
  }

  setTimeout(cb: () => void, delay: number): TimerId {
    const event: ClockEvent = {
      id: this.nextId++,
      time: this._now + delay,
      seq: this.seq++,
      cb,
      cancelled: false,
    };
    this.byId.set(event.id, event);
    let lo = 0;
    let hi = this.queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const other = this.queue[mid]!;
      if (other.time < event.time || (other.time === event.time && other.seq < event.seq)) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    this.queue.splice(lo, 0, event);
    return event.id;
  }

  clearTimeout(id: TimerId): void {
    const event = this.byId.get(id);
    if (event) {
      event.cancelled = true;
      this.byId.delete(id);
    }
  }

  advance(ms: number): void {
    this.advanceTo(this._now + ms);
  }

  advanceTo(target: number): void {
    for (;;) {
      const next = this.queue[0];
      if (!next || next.time > target) break;
      this.queue.shift();
      if (next.cancelled) continue;
      this.byId.delete(next.id);
      this._now = next.time;
      next.cb();
    }
    this._now = target;
  }

  runAll(): void {
    for (;;) {
      const next = this.queue[0];
      if (!next) break;
      this.advanceTo(next.time);
    }
  }
}
