import { buildGraph, type Graph, type TaskDefinition } from "./graph.js";

export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export type TaskFn = (ctx: TaskContext) => void | Promise<void>;

export interface TaskContext {
  readonly id: string;
}

export interface ExecutionResult {
  readonly statuses: ReadonlyMap<string, TaskStatus>;
  /** ids in the exact order each task body was started; each id appears at most once */
  readonly started: readonly string[];
  readonly errors: ReadonlyMap<string, unknown>;
}

export interface ExecutableTask extends TaskDefinition {
  run: TaskFn;
}

/**
 * Deterministic executor: runs ready tasks one at a time in a stable,
 * sorted order. A task runs only after every dependency has succeeded.
 * A failure (or cancellation) cancels its transitive successors that are
 * still pending; tasks that already succeeded are never rolled back, and
 * unrelated branches keep running.
 */
export class Executor {
  private readonly graph: Graph;
  private readonly fns = new Map<string, TaskFn>();
  private readonly statuses = new Map<string, TaskStatus>();
  private readonly errors = new Map<string, unknown>();
  private readonly startedLog: string[] = [];

  constructor(tasks: readonly ExecutableTask[]) {
    this.graph = buildGraph(tasks);
    for (const task of tasks) {
      this.fns.set(task.id, task.run);
      this.statuses.set(task.id, "pending");
    }
  }

  status(id: string): TaskStatus {
    const s = this.statuses.get(id);
    if (s === undefined) throw new Error(`unknown task "${id}"`);
    return s;
  }

  /**
   * Cancel a task and, transitively, every successor that has not reached a
   * terminal state. Succeeded/failed nodes are left untouched (no rollback).
   */
  cancel(id: string): void {
    if (this.status(id) !== "pending") return;
    this.statuses.set(id, "cancelled");
    for (const next of this.graph.dependents.get(id)!) this.cancel(next);
  }

  async run(): Promise<ExecutionResult> {
    for (const id of this.graph.order) {
      if (this.statuses.get(id) !== "pending") continue;
      const blockedBy = this.graph.deps
        .get(id)!
        .find((dep) => this.statuses.get(dep) !== "succeeded");
      if (blockedBy !== undefined) {
        // A dependency failed or was cancelled: cancel this subtree only.
        this.cancel(id);
        continue;
      }
      this.statuses.set(id, "running");
      this.startedLog.push(id);
      try {
        await this.fns.get(id)!.call(null, { id });
        this.statuses.set(id, "succeeded");
      } catch (err) {
        this.statuses.set(id, "failed");
        this.errors.set(id, err);
        // Failure cancels only this node's pending successors.
        for (const next of this.graph.dependents.get(id)!) this.cancel(next);
      }
    }
    return {
      statuses: new Map(this.statuses),
      started: [...this.startedLog],
      errors: new Map(this.errors),
    };
  }
}
