/**
 * Deterministic logical-time scheduler for tests.
 *
 * Semantics:
 * - The logical clock only moves forward; advancing to a past time is rejected.
 * - Advancing time completes only I/O events whose deadline has been reached
 *   (deadline <= tick target). Future events stay pending.
 * - Events are delivered in (time, registration id) order, so events registered
 *   for the same time — including ones registered reentrantly from a handler —
 *   are appended to the tail of that time slot's queue.
 * - Microtasks form a separate FIFO queue drained in registration-id order
 *   after each I/O delivery (and at end of tick), mirroring an event loop.
 * - Each tick has a delivery budget. When the budget is exhausted mid-tick the
 *   clock stops at the last delivered event and the tick can be continued with
 *   `resume()`.
 * - Every delivery and cancellation is recorded in a trace with its logical
 *   time, and each advance/resume call returns a report of what it delivered.
 */

export type TaskKind = 'io' | 'microtask';

export interface TraceEntry {
  /** Global trace sequence number. */
  readonly seq: number;
  /** Logical time at which the action happened. */
  readonly time: number;
  /** Registration id of the event. */
  readonly id: number;
  readonly kind: TaskKind;
  readonly label: string;
  readonly action: 'delivered' | 'cancelled';
}

export interface TickReport {
  /** Target time the tick is advancing to. */
  readonly target: number;
  /** Logical clock value after the call (== target unless the tick paused). */
  readonly now: number;
  /** True when the budget ran out with due work remaining; call `resume()`. */
  readonly exhausted: boolean;
  /** Deliveries made during this call, in delivery order. */
  readonly delivered: TraceEntry[];
}

export interface Handle {
  readonly id: number;
  readonly time: number;
  readonly kind: TaskKind;
  readonly label: string;
  readonly cancelled: boolean;
  /** Cancel the event. Returns false if it was already cancelled or delivered. */
  cancel(): boolean;
}

export interface SchedulerOptions {
  /** Max deliveries per advance/resume call. Defaults to Infinity. */
  budget?: number;
  /** Initial logical clock value. Defaults to 0. */
  startTime?: number;
}

export class ClockBackwardError extends Error {
  constructor(now: number, target: number) {
    super(`refusing to move the clock backward: now=${now}, target=${target}`);
    this.name = 'ClockBackwardError';
  }
}

export class ReentrantAdvanceError extends Error {
  constructor() {
    super('advanceTo/advanceBy cannot be called from inside a running tick');
    this.name = 'ReentrantAdvanceError';
  }
}

export class PausedTickError extends Error {
  constructor() {
    super('a budget-exhausted tick is paused; call resume() before advancing again');
    this.name = 'PausedTickError';
  }
}

export class NoPausedTickError extends Error {
  constructor() {
    super('no paused tick to resume');
    this.name = 'NoPausedTickError';
  }
}

interface ScheduledEvent {
  id: number;
  time: number;
  kind: TaskKind;
  label: string;
  cancelled: boolean;
  delivered: boolean;
  run: () => void;
}

function comesBefore(a: ScheduledEvent, b: ScheduledEvent): boolean {
  return a.time < b.time || (a.time === b.time && a.id < b.id);
}

export class Scheduler {
  #now: number;
  readonly #budget: number;
  #nextId = 1;
  #seq = 0;
  /** Min-heap of pending I/O events ordered by (time, id). */
  #heap: ScheduledEvent[] = [];
  /** FIFO queue of pending microtasks; ids are monotonically increasing. */
  #micro: ScheduledEvent[] = [];
  #trace: TraceEntry[] = [];
  /** Target of the active or paused tick; null when no tick is in flight. */
  #tickTarget: number | null = null;
  #budgetLeft = 0;
  #ticking = false;

  constructor(options: SchedulerOptions = {}) {
    const budget = options.budget ?? Number.POSITIVE_INFINITY;
    if (!(budget >= 1)) {
      throw new RangeError(`budget must be >= 1, got ${budget}`);
    }
    this.#budget = budget;
    this.#now = options.startTime ?? 0;
  }

  /** Current logical time. */
  now(): number {
    return this.#now;
  }

  /** True while a budget-exhausted tick is waiting for `resume()`. */
  get paused(): boolean {
    return this.#tickTarget !== null && !this.#ticking;
  }

  /** Number of pending (not yet delivered, not cancelled) events. */
  get pendingCount(): number {
    let n = 0;
    for (const e of this.#heap) if (!e.cancelled) n++;
    for (const e of this.#micro) if (!e.cancelled) n++;
    return n;
  }

  /** Full trace of deliveries and cancellations, in order. */
  trace(): readonly TraceEntry[] {
    return this.#trace;
  }

  /** Schedule an I/O event at an absolute logical time. */
  scheduleAt(time: number, label: string, run: () => void): Handle {
    if (!Number.isFinite(time)) {
      throw new RangeError(`time must be finite, got ${time}`);
    }
    if (time < this.#now) {
      throw new ClockBackwardError(this.#now, time);
    }
    return this.#makeHandle({ time, kind: 'io', label, run });
  }

  /** Schedule an I/O event `delay` time units from now. */
  scheduleIn(delay: number, label: string, run: () => void): Handle {
    if (delay < 0) {
      throw new ClockBackwardError(this.#now, this.#now + delay);
    }
    return this.scheduleAt(this.#now + delay, label, run);
  }

  /** Queue a microtask; runs in registration-id order during the next tick. */
  queueMicrotask(label: string, run: () => void): Handle {
    return this.#makeHandle({ time: this.#now, kind: 'microtask', label, run });
  }

  /** Advance the logical clock to `target`, delivering only due events. */
  advanceTo(target: number): TickReport {
    if (!Number.isFinite(target)) {
      throw new RangeError(`target must be finite, got ${target}`);
    }
    if (target < this.#now) {
      throw new ClockBackwardError(this.#now, target);
    }
    if (this.#ticking) {
      throw new ReentrantAdvanceError();
    }
    if (this.#tickTarget !== null) {
      throw new PausedTickError();
    }
    this.#tickTarget = target;
    this.#budgetLeft = this.#budget;
    return this.#continueTick();
  }

  /** Advance the logical clock by `dt` (must be >= 0). */
  advanceBy(dt: number): TickReport {
    return this.advanceTo(this.#now + dt);
  }

  /** Continue a budget-exhausted tick with a fresh budget. */
  resume(): TickReport {
    if (this.#ticking || this.#tickTarget === null) {
      throw new NoPausedTickError();
    }
    this.#budgetLeft = this.#budget;
    return this.#continueTick();
  }

  #makeHandle(init: { time: number; kind: TaskKind; label: string; run: () => void }): Handle {
    const event: ScheduledEvent = {
      id: this.#nextId++,
      time: init.time,
      kind: init.kind,
      label: init.label,
      cancelled: false,
      delivered: false,
      run: init.run,
    };
    if (init.kind === 'io') {
      this.#heapPush(event);
    } else {
      this.#micro.push(event);
    }
    const handle: Handle = {
      id: event.id,
      time: event.time,
      kind: event.kind,
      label: event.label,
      get cancelled() {
        return event.cancelled;
      },
      cancel: () => {
        if (event.cancelled || event.delivered) return false;
        event.cancelled = true;
        this.#record(event, 'cancelled');
        return true;
      },
    };
    return handle;
  }

  #continueTick(): TickReport {
    const target = this.#tickTarget!;
    const delivered: TraceEntry[] = [];
    this.#ticking = true;
    try {
      this.#runTick(delivered);
    } finally {
      this.#ticking = false;
    }
    const exhausted = this.#hasDueWork(target);
    if (!exhausted) {
      this.#now = target;
      this.#tickTarget = null;
    }
    return { target, now: this.#now, exhausted, delivered };
  }

  #runTick(delivered: TraceEntry[]): void {
    const target = this.#tickTarget!;
    while (this.#budgetLeft > 0) {
      this.#dropCancelledIo();
      const top = this.#heap[0];
      if (top !== undefined && top.time <= target) {
        this.#heapPop();
        this.#now = top.time;
        this.#deliver(top, delivered);
        this.#budgetLeft--;
        // Drain the microtask queue after each I/O delivery, in id order.
        while (this.#dropCancelledMicro(), this.#micro.length > 0) {
          if (this.#budgetLeft <= 0) return;
          this.#deliver(this.#micro.shift()!, delivered);
          this.#budgetLeft--;
        }
      } else if (this.#dropCancelledMicro(), this.#micro.length > 0) {
        this.#deliver(this.#micro.shift()!, delivered);
        this.#budgetLeft--;
      } else {
        return;
      }
    }
  }

  #hasDueWork(target: number): boolean {
    this.#dropCancelledIo();
    this.#dropCancelledMicro();
    const top = this.#heap[0];
    return (top !== undefined && top.time <= target) || this.#micro.length > 0;
  }

  #deliver(event: ScheduledEvent, delivered: TraceEntry[]): void {
    event.delivered = true;
    const entry = this.#record(event, 'delivered');
    delivered.push(entry);
    event.run();
  }

  #record(event: ScheduledEvent, action: TraceEntry['action']): TraceEntry {
    const entry: TraceEntry = {
      seq: this.#seq++,
      time: this.#now,
      id: event.id,
      kind: event.kind,
      label: event.label,
      action,
    };
    this.#trace.push(entry);
    return entry;
  }

  #dropCancelledIo(): void {
    while (this.#heap.length > 0 && this.#heap[0]!.cancelled) {
      this.#heapPop();
    }
  }

  #dropCancelledMicro(): boolean {
    while (this.#micro.length > 0 && this.#micro[0]!.cancelled) {
      this.#micro.shift();
    }
    return this.#micro.length > 0;
  }

  #heapPush(event: ScheduledEvent): void {
    const heap = this.#heap;
    heap.push(event);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!comesBefore(heap[i]!, heap[parent]!)) break;
      [heap[i], heap[parent]] = [heap[parent]!, heap[i]!];
      i = parent;
    }
  }

  #heapPop(): void {
    const heap = this.#heap;
    const last = heap.pop()!;
    if (heap.length === 0) return;
    heap[0] = last;
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let smallest = i;
      if (left < heap.length && comesBefore(heap[left]!, heap[smallest]!)) smallest = left;
      if (right < heap.length && comesBefore(heap[right]!, heap[smallest]!)) smallest = right;
      if (smallest === i) break;
      [heap[i], heap[smallest]] = [heap[smallest]!, heap[i]!];
      i = smallest;
    }
  }
}
