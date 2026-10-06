export type EventKind = 'io' | 'microtask';

export interface TraceEntry {
  readonly time: number;
  readonly id: number;
  readonly kind: EventKind;
  readonly label: string;
}

export interface RunResult {
  readonly delivered: number;
  readonly remaining: number;
  readonly exhausted: boolean;
}

export type Handler = (entry: TraceEntry) => void;

interface ScheduledEvent {
  readonly id: number;
  readonly time: number;
  readonly kind: EventKind;
  readonly label: string;
  readonly handler?: Handler;
  cancelled: boolean;
  delivered: boolean;
}

export class ClockBackwardsError extends Error {
  constructor(
    readonly currentTime: number,
    readonly requestedTime: number,
  ) {
    super(`clock moved backwards: now=${currentTime}, requested=${requestedTime}`);
    this.name = 'ClockBackwardsError';
  }
}

/**
 * 逻辑时间调度器。
 *
 * 语义约定：
 * - 推进逻辑时间时只交付 time <= now 的已到期事件；
 * - 同一时刻的事件按注册 ID 升序交付（微任务亦遵循此序）；
 * - 交付过程中新增的同刻事件追加到当前待交付队列的队尾；
 * - 单次推进可携带交付预算，预算耗尽后可通过 resume() 续跑；
 * - 时钟拒绝后退，advanceTo 更早时刻会抛出 ClockBackwardsError。
 */
export class LogicalScheduler {
  private currentTime = 0;
  private nextId = 1;
  private queue: ScheduledEvent[] = [];
  private due: ScheduledEvent[] = [];
  private readonly traceLog: TraceEntry[] = [];

  now(): number {
    return this.currentTime;
  }

  scheduleIO(delay: number, label: string, handler?: Handler): number {
    if (!Number.isFinite(delay) || delay < 0) {
      throw new RangeError(`delay must be a finite number >= 0, got ${delay}`);
    }
    return this.enqueue(this.currentTime + delay, 'io', label, handler);
  }

  scheduleMicrotask(label: string, handler?: Handler): number {
    return this.enqueue(this.currentTime, 'microtask', label, handler);
  }

  cancel(id: number): boolean {
    const event = this.findLive(id);
    if (!event) {
      return false;
    }
    event.cancelled = true;
    return true;
  }

  pendingCount(): number {
    return this.countLive(this.queue) + this.countLive(this.due);
  }

  advanceTo(time: number, budget = Number.POSITIVE_INFINITY): RunResult {
    if (!Number.isFinite(time)) {
      throw new RangeError(`time must be finite, got ${time}`);
    }
    if (time < this.currentTime) {
      throw new ClockBackwardsError(this.currentTime, time);
    }
    this.currentTime = time;
    return this.deliver(budget);
  }

  tick(delta: number, budget = Number.POSITIVE_INFINITY): RunResult {
    if (!Number.isFinite(delta) || delta < 0) {
      throw new RangeError(`delta must be a finite number >= 0, got ${delta}`);
    }
    return this.advanceTo(this.currentTime + delta, budget);
  }

  resume(budget = Number.POSITIVE_INFINITY): RunResult {
    return this.deliver(budget);
  }

  trace(): readonly TraceEntry[] {
    return this.traceLog.slice();
  }

  formatTrace(): string {
    return this.traceLog
      .map((entry) => `t=${entry.time} #${entry.id} ${entry.kind}:${entry.label}`)
      .join('\n');
  }

  private enqueue(time: number, kind: EventKind, label: string, handler?: Handler): number {
    const event: ScheduledEvent = {
      id: this.nextId++,
      time,
      kind,
      label,
      handler,
      cancelled: false,
      delivered: false,
    };
    if (this.due.length > 0 && time <= this.currentTime) {
      this.due.push(event);
    } else {
      let lo = 0;
      let hi = this.queue.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const current = this.queue[mid];
        if (current.time < time || (current.time === time && current.id < event.id)) {
          lo = mid + 1;
        } else {
          hi = mid;
        }
      }
      this.queue.splice(lo, 0, event);
    }
    return event.id;
  }

  private collectDue(): void {
    while (this.queue.length > 0 && this.queue[0].time <= this.currentTime) {
      this.due.push(this.queue.shift()!);
    }
  }

  private deliver(budget: number): RunResult {
    if (!(budget >= 0)) {
      throw new RangeError(`budget must be >= 0, got ${budget}`);
    }
    let delivered = 0;
    for (;;) {
      this.collectDue();
      while (this.due.length > 0 && delivered < budget) {
        const event = this.due.shift()!;
        if (event.cancelled) {
          continue;
        }
        event.delivered = true;
        const entry: TraceEntry = {
          time: event.time,
          id: event.id,
          kind: event.kind,
          label: event.label,
        };
        this.traceLog.push(entry);
        delivered += 1;
        event.handler?.(entry);
      }
      if (delivered >= budget) {
        break;
      }
      if (this.queue.length === 0 || this.queue[0].time > this.currentTime) {
        break;
      }
    }
    let remaining = this.countLive(this.due);
    for (const event of this.queue) {
      if (event.time > this.currentTime) {
        break;
      }
      if (!event.cancelled) {
        remaining += 1;
      }
    }
    return { delivered, remaining, exhausted: remaining > 0 };
  }

  private findLive(id: number): ScheduledEvent | undefined {
    for (const list of [this.due, this.queue]) {
      for (const event of list) {
        if (event.id === id) {
          return event.cancelled || event.delivered ? undefined : event;
        }
      }
    }
    return undefined;
  }

  private countLive(list: ScheduledEvent[]): number {
    let count = 0;
    for (const event of list) {
      if (!event.cancelled && !event.delivered) {
        count += 1;
      }
    }
    return count;
  }
}
