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
export class ClockBackwardError extends Error {
    constructor(now, target) {
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
function comesBefore(a, b) {
    return a.time < b.time || (a.time === b.time && a.id < b.id);
}
export class Scheduler {
    #now;
    #budget;
    #nextId = 1;
    #seq = 0;
    /** Min-heap of pending I/O events ordered by (time, id). */
    #heap = [];
    /** FIFO queue of pending microtasks; ids are monotonically increasing. */
    #micro = [];
    #trace = [];
    /** Target of the active or paused tick; null when no tick is in flight. */
    #tickTarget = null;
    #budgetLeft = 0;
    #ticking = false;
    constructor(options = {}) {
        const budget = options.budget ?? Number.POSITIVE_INFINITY;
        if (!(budget >= 1)) {
            throw new RangeError(`budget must be >= 1, got ${budget}`);
        }
        this.#budget = budget;
        this.#now = options.startTime ?? 0;
    }
    /** Current logical time. */
    now() {
        return this.#now;
    }
    /** True while a budget-exhausted tick is waiting for `resume()`. */
    get paused() {
        return this.#tickTarget !== null && !this.#ticking;
    }
    /** Number of pending (not yet delivered, not cancelled) events. */
    get pendingCount() {
        let n = 0;
        for (const e of this.#heap)
            if (!e.cancelled)
                n++;
        for (const e of this.#micro)
            if (!e.cancelled)
                n++;
        return n;
    }
    /** Full trace of deliveries and cancellations, in order. */
    trace() {
        return this.#trace;
    }
    /** Schedule an I/O event at an absolute logical time. */
    scheduleAt(time, label, run) {
        if (!Number.isFinite(time)) {
            throw new RangeError(`time must be finite, got ${time}`);
        }
        if (time < this.#now) {
            throw new ClockBackwardError(this.#now, time);
        }
        return this.#makeHandle({ time, kind: 'io', label, run });
    }
    /** Schedule an I/O event `delay` time units from now. */
    scheduleIn(delay, label, run) {
        if (delay < 0) {
            throw new ClockBackwardError(this.#now, this.#now + delay);
        }
        return this.scheduleAt(this.#now + delay, label, run);
    }
    /** Queue a microtask; runs in registration-id order during the next tick. */
    queueMicrotask(label, run) {
        return this.#makeHandle({ time: this.#now, kind: 'microtask', label, run });
    }
    /** Advance the logical clock to `target`, delivering only due events. */
    advanceTo(target) {
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
    advanceBy(dt) {
        return this.advanceTo(this.#now + dt);
    }
    /** Continue a budget-exhausted tick with a fresh budget. */
    resume() {
        if (this.#ticking || this.#tickTarget === null) {
            throw new NoPausedTickError();
        }
        this.#budgetLeft = this.#budget;
        return this.#continueTick();
    }
    #makeHandle(init) {
        const event = {
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
        }
        else {
            this.#micro.push(event);
        }
        const handle = {
            id: event.id,
            time: event.time,
            kind: event.kind,
            label: event.label,
            get cancelled() {
                return event.cancelled;
            },
            cancel: () => {
                if (event.cancelled || event.delivered)
                    return false;
                event.cancelled = true;
                this.#record(event, 'cancelled');
                return true;
            },
        };
        return handle;
    }
    #continueTick() {
        const target = this.#tickTarget;
        const delivered = [];
        this.#ticking = true;
        try {
            this.#runTick(delivered);
        }
        finally {
            this.#ticking = false;
        }
        const exhausted = this.#hasDueWork(target);
        if (!exhausted) {
            this.#now = target;
            this.#tickTarget = null;
        }
        return { target, now: this.#now, exhausted, delivered };
    }
    #runTick(delivered) {
        const target = this.#tickTarget;
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
                    if (this.#budgetLeft <= 0)
                        return;
                    this.#deliver(this.#micro.shift(), delivered);
                    this.#budgetLeft--;
                }
            }
            else if (this.#dropCancelledMicro(), this.#micro.length > 0) {
                this.#deliver(this.#micro.shift(), delivered);
                this.#budgetLeft--;
            }
            else {
                return;
            }
        }
    }
    #hasDueWork(target) {
        this.#dropCancelledIo();
        this.#dropCancelledMicro();
        const top = this.#heap[0];
        return (top !== undefined && top.time <= target) || this.#micro.length > 0;
    }
    #deliver(event, delivered) {
        event.delivered = true;
        const entry = this.#record(event, 'delivered');
        delivered.push(entry);
        event.run();
    }
    #record(event, action) {
        const entry = {
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
    #dropCancelledIo() {
        while (this.#heap.length > 0 && this.#heap[0].cancelled) {
            this.#heapPop();
        }
    }
    #dropCancelledMicro() {
        while (this.#micro.length > 0 && this.#micro[0].cancelled) {
            this.#micro.shift();
        }
        return this.#micro.length > 0;
    }
    #heapPush(event) {
        const heap = this.#heap;
        heap.push(event);
        let i = heap.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (!comesBefore(heap[i], heap[parent]))
                break;
            [heap[i], heap[parent]] = [heap[parent], heap[i]];
            i = parent;
        }
    }
    #heapPop() {
        const heap = this.#heap;
        const last = heap.pop();
        if (heap.length === 0)
            return;
        heap[0] = last;
        let i = 0;
        for (;;) {
            const left = 2 * i + 1;
            const right = left + 1;
            let smallest = i;
            if (left < heap.length && comesBefore(heap[left], heap[smallest]))
                smallest = left;
            if (right < heap.length && comesBefore(heap[right], heap[smallest]))
                smallest = right;
            if (smallest === i)
                break;
            [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
            i = smallest;
        }
    }
}
