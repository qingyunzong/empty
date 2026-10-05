import { Prng } from "./prng";

/** Event kinds recorded in the trace. */
export type EventType = "register" | "schedule" | "complete" | "cancel" | "timeout";

export interface TraceEvent {
  /** Position in the trace. */
  seq: number;
  /** Virtual time at which the event was recorded. */
  time: number;
  type: EventType;
  /** Task that owns the event. */
  task: string;
  /** Await-boundary id, e.g. "worker-a#2". */
  boundary?: string;
  detail?: string;
  /** For "schedule" events: the full ready set the choice was made from. */
  ready?: string[];
}

/**
 * Serializable scheduler state. `rngState` is included so a segmented run
 * resumed from a snapshot continues the exact same random sequence as a
 * full, uninterrupted run.
 */
export interface Snapshot {
  /** Number of schedule decisions made so far. */
  step: number;
  time: number;
  rngState: number;
  traceLength: number;
  /** Boundary ids of tasks currently suspended at an await boundary. */
  pending: string[];
}

export class ReplayMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayMismatchError";
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export class CancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CancelledError";
  }
}

export interface BoundaryOptions {
  /** Virtual milliseconds before the boundary becomes ready (sleep). */
  delay?: number;
  /** Virtual milliseconds after which a not-yet-ready boundary times out. */
  timeout?: number;
  /** Human-readable label recorded in the trace. */
  label?: string;
}

export type TaskFn = (ctx: TaskContext) => Promise<void>;

type TaskStatus = "active" | "waiting" | "done" | "cancelled" | "failed";

interface TaskState {
  id: string;
  boundarySeq: number;
  status: TaskStatus;
  readyAt: number;
  timeoutAt?: number;
  wake?: (err?: Error) => void;
  cancelRequested: boolean;
}

/** Per-task handle passed to task functions. */
export class TaskContext {
  constructor(
    private readonly scheduler: Scheduler,
    readonly taskId: string,
  ) {}

  /** Pure await boundary: ready on the next scheduling step. */
  checkpoint(label?: string): Promise<void> {
    return this.scheduler.boundary(this.taskId, { label });
  }

  /** Await boundary that becomes ready after `ms` virtual milliseconds. */
  sleep(ms: number, opts: { timeout?: number; label?: string } = {}): Promise<void> {
    return this.scheduler.boundary(this.taskId, { ...opts, delay: ms });
  }

  /** Draw from the scheduler's seeded PRNG (kept inside the trace's determinism). */
  random(): number {
    return this.scheduler.random();
  }

  /** Cancel another task at its current (or next) await boundary. */
  cancelTask(taskId: string): boolean {
    return this.scheduler.cancel(taskId);
  }

  now(): number {
    return this.scheduler.time;
  }
}

function boundaryIdOf(task: TaskState): string {
  return `${task.id}#${task.boundarySeq}`;
}

function sameEvent(a: TraceEvent, b: TraceEvent): boolean {
  return (
    a.type === b.type &&
    a.time === b.time &&
    a.task === b.task &&
    a.boundary === b.boundary &&
    a.detail === b.detail &&
    JSON.stringify(a.ready ?? null) === JSON.stringify(b.ready ?? null)
  );
}

function describeEvent(e: TraceEvent | undefined): string {
  return e === undefined ? "<end of trace>" : JSON.stringify({ ...e, seq: undefined });
}

/**
 * Deterministic cooperative scheduler for async test workloads.
 *
 * Every `await` of a TaskContext operation registers a schedulable event
 * (an await boundary). The scheduler repeatedly picks one ready boundary
 * using a seeded PRNG, records every register/schedule/complete/cancel/
 * timeout in an ordered trace, and can replay a recorded trace — rejecting
 * it when the pending event set or the chosen event does not match.
 */
export class Scheduler {
  readonly prng: Prng;
  time = 0;

  private readonly tasks = new Map<string, TaskState>();
  private readonly trace: TraceEvent[] = [];
  private stepCount = 0;
  private replayTrace: TraceEvent[] | null = null;
  private replayCursor = 0;
  private fatal: ReplayMismatchError | null = null;

  constructor(options: { seed: number }) {
    this.prng = new Prng(options.seed);
  }

  /** Register a task. The task body starts on the first scheduler flush. */
  spawn(id: string, fn: TaskFn): void {
    if (this.tasks.has(id)) throw new Error(`duplicate task id: ${id}`);
    const state: TaskState = {
      id,
      boundarySeq: 0,
      status: "active",
      readyAt: 0,
      cancelRequested: false,
    };
    this.tasks.set(id, state);
    Promise.resolve()
      .then(() => fn(new TaskContext(this, id)))
      .then(
        () => {
          if (state.status !== "cancelled") {
            state.status = "done";
            this.recordSafely("complete", id);
          }
        },
        (err: unknown) => {
          if (err instanceof ReplayMismatchError) {
            state.status = "failed"; // fatal replay divergence, already stored
          } else if (err instanceof CancelledError) {
            state.status = "cancelled"; // "cancel" was already recorded
          } else {
            state.status = "failed";
            const message = err instanceof Error ? err.message : String(err);
            this.recordSafely("complete", id, undefined, `error: ${message}`);
          }
        },
      );
  }

  /** Await boundary registration — the core schedulable event. */
  boundary(taskId: string, opts: BoundaryOptions): Promise<void> {
    const task = this.mustGet(taskId);
    if (task.cancelRequested) {
      task.cancelRequested = false;
      this.record("cancel", taskId, undefined, "cancelled at next boundary");
      return Promise.reject(new CancelledError(`task ${taskId} was cancelled`));
    }
    task.boundarySeq += 1;
    task.status = "waiting";
    task.readyAt = this.time + Math.max(0, opts.delay ?? 0);
    task.timeoutAt = opts.timeout === undefined ? undefined : this.time + Math.max(0, opts.timeout);
    const boundary = boundaryIdOf(task);
    this.record("register", taskId, boundary, opts.label);
    return new Promise<void>((resolve, reject) => {
      task.wake = (err?: Error) => {
        if (err) reject(err);
        else resolve();
      };
    });
  }

  random(): number {
    return this.prng.next();
  }

  /** Cancel a task. Returns false if the task is already settled. */
  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`unknown task: ${taskId}`);
    if (task.status === "done" || task.status === "cancelled" || task.status === "failed") {
      return false;
    }
    if (task.status === "waiting") {
      this.record("cancel", taskId, boundaryIdOf(task));
      const wake = task.wake;
      task.wake = undefined;
      task.status = "active";
      wake?.(new CancelledError(`task ${taskId} was cancelled`));
    } else {
      task.cancelRequested = true; // takes effect at the next boundary
    }
    return true;
  }

  /** Feed a recorded trace: subsequent steps verify instead of choosing. */
  setReplay(trace: readonly TraceEvent[]): void {
    this.replayTrace = trace.slice();
    this.replayCursor = 0;
  }

  /** Leave replay mode; further steps are chosen by the seeded PRNG again. */
  clearReplay(): void {
    this.replayTrace = null;
  }

  getTrace(): readonly TraceEvent[] {
    return this.trace;
  }

  getStepCount(): number {
    return this.stepCount;
  }

  snapshot(): Snapshot {
    const pending: string[] = [];
    for (const task of this.tasks.values()) {
      if (task.status === "waiting") pending.push(boundaryIdOf(task));
    }
    pending.sort();
    return {
      step: this.stepCount,
      time: this.time,
      rngState: this.prng.getState(),
      traceLength: this.trace.length,
      pending,
    };
  }

  isSettled(): boolean {
    for (const task of this.tasks.values()) {
      if (task.status === "active" || task.status === "waiting") return false;
    }
    return true;
  }

  /**
   * Run until all tasks settle, `opts.stopAtStep` schedule decisions have
   * been made, or a replay prefix is exhausted (pausable segmentation).
   */
  async run(opts: { stopAtStep?: number } = {}): Promise<readonly TraceEvent[]> {
    for (;;) {
      if (opts.stopAtStep !== undefined && this.stepCount >= opts.stopAtStep) break;
      const progressed = await this.step();
      if (!progressed) break;
    }
    if (this.replayTrace && this.replayCursor !== this.replayTrace.length && this.isSettled()) {
      throw new ReplayMismatchError(
        `replay has ${this.replayTrace.length - this.replayCursor} leftover events after the run settled`,
      );
    }
    return this.trace;
  }

  /** One scheduling decision (plus the microtask flush it unleashes). */
  async step(): Promise<boolean> {
    if (this.fatal) throw this.fatal;
    if (this.isSettled()) return false;
    if (this.replayTrace && this.replayCursor >= this.replayTrace.length) return false;

    let ready = this.readyTasks();
    while (ready.length === 0) {
      const nextAt = this.nextEventAt();
      if (nextAt === Infinity) {
        // Tasks may not have reached their first boundary yet (startup) or
        // may be mid-flight after a timeout; let them run and re-check.
        if (this.hasActiveTasks()) {
          await this.flush();
          if (this.fatal) throw this.fatal;
          if (this.isSettled()) return false;
          ready = this.readyTasks();
          continue;
        }
        return false; // deadlock: nothing can ever wake
      }
      this.time = nextAt;
      if (this.fireDueTimeouts() > 0) await this.flush();
      if (this.fatal) throw this.fatal;
      if (this.isSettled()) return false;
      ready = this.readyTasks();
    }

    const readyIds = ready.map(boundaryIdOf).sort();
    let chosen: TaskState;
    if (this.replayTrace) {
      const expected = this.replayTrace[this.replayCursor];
      if (!expected || expected.type !== "schedule") {
        throw new ReplayMismatchError(
          `expected a schedule event at trace[${this.replayCursor}], got ${describeEvent(expected)}`,
        );
      }
      const expectedReady = (expected.ready ?? []).slice().sort();
      if (JSON.stringify(expectedReady) !== JSON.stringify(readyIds)) {
        throw new ReplayMismatchError(
          `event set mismatch at step ${this.stepCount}: ` +
            `expected ready set ${JSON.stringify(expectedReady)}, actual ${JSON.stringify(readyIds)}`,
        );
      }
      const found = this.tasks.get(expected.task);
      if (!found || !ready.includes(found)) {
        throw new ReplayMismatchError(
          `scheduled task ${JSON.stringify(expected.task)} is not in the ready set ${JSON.stringify(readyIds)}`,
        );
      }
      chosen = found;
    } else {
      chosen = this.prng.pick(ready);
    }

    this.record("schedule", chosen.id, boundaryIdOf(chosen), undefined, readyIds);
    this.stepCount += 1;
    const wake = chosen.wake;
    chosen.wake = undefined;
    chosen.status = "active";
    wake?.();
    await this.flush();
    if (this.fatal) throw this.fatal;
    return true;
  }

  /**
   * Rebuild a scheduler at a snapshot by replaying the trace prefix, then
   * verify the reconstructed state against the snapshot (random state
   * included) and adopt the snapshot's RNG state for continuation.
   */
  static async restore(
    snapshot: Snapshot,
    tracePrefix: readonly TraceEvent[],
    seed: number,
    register: (scheduler: Scheduler) => void,
  ): Promise<Scheduler> {
    const scheduler = new Scheduler({ seed });
    register(scheduler);
    scheduler.setReplay(tracePrefix);
    await scheduler.run(); // pauses when the prefix is exhausted
    scheduler.clearReplay();
    const rebuilt = scheduler.snapshot();
    if (rebuilt.step !== snapshot.step || rebuilt.time !== snapshot.time) {
      throw new ReplayMismatchError(
        `restore diverged: expected step=${snapshot.step} time=${snapshot.time}, ` +
          `got step=${rebuilt.step} time=${rebuilt.time}`,
      );
    }
    if (JSON.stringify(rebuilt.pending) !== JSON.stringify(snapshot.pending)) {
      throw new ReplayMismatchError(
        `restore diverged: expected pending ${JSON.stringify(snapshot.pending)}, ` +
          `got ${JSON.stringify(rebuilt.pending)}`,
      );
    }
    scheduler.prng.setState(snapshot.rngState);
    return scheduler;
  }

  private mustGet(taskId: string): TaskState {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`unknown task: ${taskId}`);
    return task;
  }

  private hasActiveTasks(): boolean {
    for (const task of this.tasks.values()) {
      if (task.status === "active") return true;
    }
    return false;
  }

  private readyTasks(): TaskState[] {
    const ready: TaskState[] = [];
    for (const task of this.tasks.values()) {
      if (task.status === "waiting" && task.readyAt <= this.time) ready.push(task);
    }
    return ready;
  }

  private nextEventAt(): number {
    let next = Infinity;
    for (const task of this.tasks.values()) {
      if (task.status !== "waiting") continue;
      if (task.readyAt < next) next = task.readyAt;
      if (task.timeoutAt !== undefined && task.timeoutAt < next) next = task.timeoutAt;
    }
    return next;
  }

  private fireDueTimeouts(): number {
    let fired = 0;
    for (const task of this.tasks.values()) {
      if (task.status !== "waiting") continue;
      if (task.timeoutAt === undefined) continue;
      if (task.timeoutAt > this.time || this.time >= task.readyAt) continue;
      this.record("timeout", task.id, boundaryIdOf(task), `deadline ${task.timeoutAt}`);
      const wake = task.wake;
      task.wake = undefined;
      task.status = "active";
      wake?.(new TimeoutError(`boundary ${boundaryIdOf(task)} timed out at ${task.timeoutAt}`));
      fired += 1;
    }
    return fired;
  }

  private record(type: EventType, task: string, boundary?: string, detail?: string, ready?: string[]): void {
    const event: TraceEvent = { seq: this.trace.length, time: this.time, type, task };
    if (boundary !== undefined) event.boundary = boundary;
    if (detail !== undefined) event.detail = detail;
    if (ready !== undefined) event.ready = ready;
    if (this.replayTrace) {
      const expected = this.replayTrace[this.replayCursor];
      if (!expected || !sameEvent(expected, event)) {
        const error = new ReplayMismatchError(
          `trace mismatch at event ${this.replayCursor}: ` +
            `expected ${describeEvent(expected)}, actual ${describeEvent(event)}`,
        );
        this.fatal ??= error;
        throw error;
      }
      this.replayCursor += 1;
    }
    this.trace.push(event);
  }

  /** Record from a task-continuation context, where a replay mismatch must
   *  be captured (via `fatal`) rather than become an unhandled rejection. */
  private recordSafely(type: EventType, task: string, boundary?: string, detail?: string): void {
    try {
      this.record(type, task, boundary, detail);
    } catch (err) {
      if (!(err instanceof ReplayMismatchError)) throw err;
    }
  }

  /** Let every queued microtask run; exactly one task is unblocked at a time. */
  private flush(): Promise<void> {
    return new Promise((resolve) => setImmediate(() => resolve()));
  }
}
