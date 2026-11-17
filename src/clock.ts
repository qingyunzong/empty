export type TimerId = number;

export interface Clock {
  now(): number;
  setTimeout(cb: () => void, ms: number): TimerId;
  clearTimeout(id: TimerId): void;
}

interface PendingTimer {
  id: TimerId;
  at: number;
  cb: () => void;
}

export class ManualClock implements Clock {
  private current = 0;
  private seq = 0;
  private timers: PendingTimer[] = [];

  now(): number {
    return this.current;
  }

  setTimeout(cb: () => void, ms: number): TimerId {
    const id = ++this.seq;
    this.timers.push({ id, at: this.current + Math.max(0, ms), cb });
    return id;
  }

  clearTimeout(id: TimerId): void {
    this.timers = this.timers.filter((t) => t.id !== id);
  }

  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      let next: PendingTimer | undefined;
      for (const t of this.timers) {
        if (t.at <= target && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) {
          next = t;
        }
      }
      if (!next) break;
      this.timers.splice(this.timers.indexOf(next), 1);
      this.current = next.at;
      next.cb();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    this.current = target;
  }

  get pending(): number {
    return this.timers.length;
  }
}
