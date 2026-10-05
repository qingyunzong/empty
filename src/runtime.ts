import { Rng } from "./prng.js";
import { fnv1a, type EventKind, type Snapshot, type TraceEvent } from "./trace.js";
import {
  CancelError,
  DeadlockError,
  ReplayMismatchError,
  TimeoutError,
} from "./errors.js";

export interface Handle {
  readonly id: number;
  readonly label: string;
  readonly done: boolean;
}

export interface TaskCtx {
  /** Await boundary: suspend for `ms` virtual milliseconds. Optional timeout. */
  sleep(ms: number, opts?: { timeout?: number }): Promise<void>;
  /** Await boundary: yield to the scheduler, resumable immediately. */
  checkpoint(): Promise<void>;
  /** Await boundary: suspend until `handle` completes or fails. */
  join(handle: Handle): Promise<void>;
  spawn(label: string, fn: (ctx: TaskCtx) => Promise<void>): Handle;
  /** Request cancellation; delivered as a schedulable `cancel` event. */
  cancel(handle: Handle): boolean;
  now(): number;
}

type Delivery = { type: "value" } | { type: "cancel" } | { type: "timeout" };

interface Pending {
  task: TaskRec;
  op: string;
  opDetail: string;
  delivery: Delivery | null;
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

interface Timer {
  at: number;
  delivery: Delivery;
  pending: Pending;
}

interface TaskRec {
  id: number;
  label: string;
  done: boolean;
  cancelArmed: boolean;
  current: Pending | null;
  joiners: Pending[];
}

const CHOICE_KINDS: ReadonlySet<EventKind> = new Set(["resume", "cancel", "timeout"]);

/**
 * Deterministic async runtime.
 *
 * Every `await` on a TaskCtx primitive registers a schedulable event with the
 * scheduler. Each scheduler step picks one matured event using a seeded PRNG
 * (record mode) or the recorded choice (replay mode), then delivers exactly
 * one resumption and drains the microtask queue, so task interleaving is
 * fully controlled. All completions, cancellations and timeouts are recorded
 * in order into a trace. Replay re-runs a program against a recorded trace
 * and rejects with ReplayMismatchError as soon as the schedulable event set
 * (or any recorded field) diverges.
 */
export class Runtime {
  private readonly rng: Rng;
  private clockValue = 0;
  private nextTaskId = 1;
  private readonly tasks = new Map<number, TaskRec>();
  private readonly ready: Pending[] = [];
  private timers: Timer[] = [];
  private readonly traceEvents: TraceEvent[] = [];
  private digestValue = 0x811c9dc5;
  private activeTasks = 0;
  private stepsTaken = 0;
  private readonly replayTrace: TraceEvent[] | null;
  private replayIndex = 0;
  /** First asynchronous failure (e.g. replay mismatch inside a continuation). */
  private failure: unknown = null;
  /** Snapshot captured after every scheduler step (includes PRNG state). */
  readonly snapshots: Snapshot[] = [];

  constructor(opts: { seed: number; replay?: TraceEvent[] }) {
    this.rng = new Rng(opts.seed);
    this.replayTrace = opts.replay ?? null;
  }

  get clock(): number {
    return this.clockValue;
  }

  spawn(label: string, fn: (ctx: TaskCtx) => Promise<void>): Handle {
    const task: TaskRec = {
      id: this.nextTaskId++,
      label,
      done: false,
      cancelArmed: false,
      current: null,
      joiners: [],
    };
    this.tasks.set(task.id, task);
    this.activeTasks++;
    this.record("spawn", label, `T${task.id}`);
    const ctx = this.makeCtx(task);
    let result: Promise<void>;
    try {
      result = Promise.resolve(fn(ctx));
    } catch (err) {
      result = Promise.reject(err);
    }
    result.then(
      () => this.settle(task, null),
      (err) => this.settle(task, err),
    );
    return this.handleOf(task);
  }

  cancel(handle: Handle): boolean {
    const task = this.tasks.get(handle.id);
    if (!task || task.done) return false;
    const cur = task.current;
    if (cur) {
      // Pending is either still waiting (timers/joiners) or already matured
      // in the ready queue; either way its delivery becomes `cancel`. Stale
      // timer/joiner entries are skipped lazily when encountered.
      cur.delivery = { type: "cancel" };
      if (!this.ready.includes(cur)) this.ready.push(cur);
    } else {
      // Task is mid-segment; the next await boundary it registers is
      // immediately converted into a cancellable delivery.
      task.cancelArmed = true;
    }
    return true;
  }

  /** Run one scheduler step (one event choice + microtask drain). */
  async step(): Promise<boolean> {
    if (this.activeTasks === 0) return false;
    while (this.ready.length === 0) {
      if (this.timers.length === 0) {
        const waiting = [...this.tasks.values()]
          .filter((t) => !t.done)
          .map((t) => `T${t.id}:${t.current ? t.current.opDetail : "running"}`);
        throw new DeadlockError(
          `deadlock: no schedulable events; still waiting: ${waiting.join(", ")}`,
        );
      }
      this.advanceClock();
    }
    const chosen = this.choose();
    this.deliver(chosen);
    await this.drain();
    if (this.failure !== null) throw this.failure;
    this.snapshots.push(this.snapshot());
    return true;
  }

  /** Run to completion; returns the recorded trace. */
  async run(): Promise<TraceEvent[]> {
    while (await this.step()) {
      // keep stepping
    }
    if (this.replayTrace && this.replayIndex !== this.replayTrace.length) {
      throw new ReplayMismatchError(
        `event set mismatch: recorded trace has ${this.replayTrace.length - this.replayIndex} extra events`,
      );
    }
    return this.trace();
  }

  trace(): TraceEvent[] {
    return this.traceEvents.map((e) => ({ ...e, candidates: [...e.candidates] }));
  }

  snapshot(): Snapshot {
    return {
      steps: this.stepsTaken,
      events: this.traceEvents.length,
      clock: this.clockValue,
      rngState: this.rng.getState(),
      digest: this.digestHex(),
    };
  }

  /**
   * Restore scheduler state from a (possibly serialized) snapshot taken at
   * the current step. Verifies the trace position and digest, then reinstates
   * the virtual clock and the full PRNG state so the run continues exactly
   * like an uninterrupted one.
   */
  restore(snap: Snapshot): void {
    if (snap.steps !== this.stepsTaken || snap.events !== this.traceEvents.length) {
      throw new Error(
        `snapshot position mismatch: runtime at ${this.stepsTaken} steps/${this.traceEvents.length} events, ` +
          `snapshot at ${snap.steps} steps/${snap.events} events`,
      );
    }
    if (snap.digest !== this.digestHex()) {
      throw new Error("snapshot digest mismatch: trace diverged before restore");
    }
    this.clockValue = snap.clock;
    this.rng.setState(snap.rngState);
  }

  private makeCtx(task: TaskRec): TaskCtx {
    return {
      sleep: (ms, opts) => this.taskSleep(task, ms, opts),
      checkpoint: () => this.taskCheckpoint(task),
      join: (handle) => this.taskJoin(task, handle),
      spawn: (label, fn) => this.spawn(label, fn),
      cancel: (handle) => this.cancel(handle),
      now: () => this.clockValue,
    };
  }

  private handleOf(task: TaskRec): Handle {
    return {
      id: task.id,
      label: task.label,
      get done() {
        return task.done;
      },
    };
  }

  private registerPending(task: TaskRec, op: string, opDetail: string): Pending {
    if (task.done) throw new Error(`task "${task.label}" already finished`);
    let resolve!: () => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const pending: Pending = { task, op, opDetail, delivery: null, promise, resolve, reject };
    task.current = pending;
    this.record("await", task.label, opDetail);
    if (task.cancelArmed) {
      task.cancelArmed = false;
      pending.delivery = { type: "cancel" };
      this.ready.push(pending);
    }
    return pending;
  }

  private taskSleep(task: TaskRec, ms: number, opts?: { timeout?: number }): Promise<void> {
    const detail = opts?.timeout != null ? `sleep:${ms}~${opts.timeout}` : `sleep:${ms}`;
    const pending = this.registerPending(task, "sleep", detail);
    if (pending.delivery === null) {
      this.timers.push({ at: this.clockValue + ms, delivery: { type: "value" }, pending });
      if (opts?.timeout != null) {
        this.timers.push({
          at: this.clockValue + opts.timeout,
          delivery: { type: "timeout" },
          pending,
        });
      }
    }
    return pending.promise;
  }

  private taskCheckpoint(task: TaskRec): Promise<void> {
    const pending = this.registerPending(task, "checkpoint", "checkpoint");
    if (pending.delivery === null) {
      pending.delivery = { type: "value" };
      this.ready.push(pending);
    }
    return pending.promise;
  }

  private taskJoin(task: TaskRec, handle: Handle): Promise<void> {
    const pending = this.registerPending(task, "join", `join:T${handle.id}`);
    if (pending.delivery === null) {
      const target = this.tasks.get(handle.id);
      if (!target) throw new Error(`unknown join target T${handle.id}`);
      if (target.done) {
        pending.delivery = { type: "value" };
        this.ready.push(pending);
      } else {
        target.joiners.push(pending);
      }
    }
    return pending.promise;
  }

  private settle(task: TaskRec, err: unknown): void {
    if (err instanceof ReplayMismatchError || err instanceof DeadlockError) {
      // A runtime invariant failed inside a task continuation; surface it
      // from step()/run() instead of recording a normal task failure.
      this.failure ??= err;
      err = null;
    }
    try {
      this.settleInner(task, err);
    } catch (e) {
      this.failure ??= e;
    }
  }

  private settleInner(task: TaskRec, err: unknown): void {
    if (task.done) return;
    task.done = true;
    this.activeTasks--;
    if (err === null || err === undefined) {
      this.record("complete", task.label, "ok");
    } else {
      const name = err instanceof Error ? err.name : "Error";
      this.record("fail", task.label, name);
    }
    for (const joiner of task.joiners) {
      if (joiner.delivery === null) {
        joiner.delivery = { type: "value" };
        this.ready.push(joiner);
      }
    }
    task.joiners.length = 0;
  }

  private advanceClock(): void {
    const at = Math.min(...this.timers.map((t) => t.at));
    this.clockValue = at;
    const due = this.timers.filter((t) => t.at === at);
    this.timers = this.timers.filter((t) => t.at !== at);
    for (const timer of due) {
      const pending = timer.pending;
      if (pending.delivery !== null) continue; // stale timer (cancelled/timed out already)
      pending.delivery = timer.delivery;
      this.ready.push(pending);
    }
  }

  private keyOf(pending: Pending): string {
    const delivery = pending.delivery;
    const suffix =
      delivery?.type === "cancel"
        ? "cancel"
        : delivery?.type === "timeout"
          ? "timeout"
          : pending.opDetail;
    return `T${pending.task.id}:${suffix}`;
  }

  private choose(): Pending {
    const candidates = this.ready.map((p) => this.keyOf(p)).sort();
    let chosen: Pending | undefined;
    if (this.replayTrace) {
      // Keep the PRNG stream aligned with the recorded run.
      this.rng.next();
      const expected = this.replayTrace[this.replayIndex];
      const key =
        expected && CHOICE_KINDS.has(expected.kind) ? expected.detail : null;
      chosen = key ? this.ready.find((p) => this.keyOf(p) === key) : undefined;
      if (!chosen) {
        throw new ReplayMismatchError(
          `event set mismatch before seq ${this.replayIndex}: recorded choice ` +
            `${expected ? expected.detail : "<none>"} not in ready set [${candidates.join(", ")}]`,
        );
      }
    } else {
      chosen = this.rng.pick(this.ready);
    }
    this.ready.splice(this.ready.indexOf(chosen), 1);
    chosen.task.current = null;
    const delivery = chosen.delivery ?? { type: "value" as const };
    const kind: EventKind = delivery.type === "value" ? "resume" : delivery.type;
    this.record(kind, chosen.task.label, this.keyOf(chosen), candidates);
    this.stepsTaken++;
    return chosen;
  }

  private deliver(pending: Pending): void {
    const delivery = pending.delivery ?? { type: "value" as const };
    if (delivery.type === "value") pending.resolve();
    else if (delivery.type === "cancel") pending.reject(new CancelError());
    else pending.reject(new TimeoutError());
  }

  private drain(): Promise<void> {
    // setImmediate fires only after the microtask queue is fully drained, so
    // the resumed task runs to its next await boundary (registering events)
    // before the next scheduler step.
    return new Promise<void>((resolve) => setImmediate(resolve));
  }

  private record(kind: EventKind, task: string, detail: string, candidates: string[] = []): void {
    const event: TraceEvent = {
      seq: this.traceEvents.length,
      kind,
      task,
      detail,
      clock: this.clockValue,
      rngState: this.rng.getState(),
      candidates,
    };
    if (this.replayTrace) {
      const expected = this.replayTrace[this.replayIndex];
      this.replayIndex++;
      if (
        !expected ||
        expected.kind !== event.kind ||
        expected.task !== event.task ||
        expected.detail !== event.detail ||
        expected.clock !== event.clock ||
        expected.rngState !== event.rngState ||
        expected.candidates.join("") !== event.candidates.join("")
      ) {
        throw new ReplayMismatchError(
          `event set mismatch at seq ${event.seq}: expected ` +
            (expected
              ? `${expected.kind} ${expected.task} ${expected.detail} [${expected.candidates.join(", ")}]`
              : "<end of trace>") +
            `, got ${event.kind} ${event.task} ${event.detail} [${event.candidates.join(", ")}]`,
        );
      }
    }
    this.traceEvents.push(event);
    this.digestValue = fnv1a(
      this.digestValue,
      JSON.stringify([
        event.kind,
        event.task,
        event.detail,
        event.clock,
        event.rngState,
        ...event.candidates,
      ]),
    );
  }

  private digestHex(): string {
    return this.digestValue.toString(16).padStart(8, "0");
  }
}
