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
export declare class ClockBackwardError extends Error {
    constructor(now: number, target: number);
}
export declare class ReentrantAdvanceError extends Error {
    constructor();
}
export declare class PausedTickError extends Error {
    constructor();
}
export declare class NoPausedTickError extends Error {
    constructor();
}
export declare class Scheduler {
    #private;
    constructor(options?: SchedulerOptions);
    /** Current logical time. */
    now(): number;
    /** True while a budget-exhausted tick is waiting for `resume()`. */
    get paused(): boolean;
    /** Number of pending (not yet delivered, not cancelled) events. */
    get pendingCount(): number;
    /** Full trace of deliveries and cancellations, in order. */
    trace(): readonly TraceEntry[];
    /** Schedule an I/O event at an absolute logical time. */
    scheduleAt(time: number, label: string, run: () => void): Handle;
    /** Schedule an I/O event `delay` time units from now. */
    scheduleIn(delay: number, label: string, run: () => void): Handle;
    /** Queue a microtask; runs in registration-id order during the next tick. */
    queueMicrotask(label: string, run: () => void): Handle;
    /** Advance the logical clock to `target`, delivering only due events. */
    advanceTo(target: number): TickReport;
    /** Advance the logical clock by `dt` (must be >= 0). */
    advanceBy(dt: number): TickReport;
    /** Continue a budget-exhausted tick with a fresh budget. */
    resume(): TickReport;
}
