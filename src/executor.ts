import { buildGraph, type TaskContext, type TaskDefinition } from "./graph.js";

export type TaskStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface TaskResult {
  status: TaskStatus;
  value?: unknown;
  error?: unknown;
}

export interface ExecutionReport {
  readonly results: ReadonlyMap<string, TaskResult>;
  /** Ids in the exact order their `run` was invoked. */
  readonly startOrder: readonly string[];
}

export class ExecutorInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutorInvariantError";
  }
}

/**
 * Executes tasks according to their dependency graph.
 *
 * Semantics:
 * - A node starts only after every dependency has succeeded.
 * - A failure cancels the failed node's transitive successors only;
 *   unrelated branches keep running.
 * - Cancellation never reverts a node that already succeeded (or is running).
 * - Every node's `run` is invoked at most once; the executor is
 *   deterministic: ready nodes are dispatched in definition order.
 */
export function execute(
  definitions: readonly TaskDefinition[],
): Promise<ExecutionReport> {
  const graph = buildGraph(definitions);
  const results = new Map<string, TaskResult>();
  const remainingDeps = new Map<string, number>();
  const ready: string[] = [];

  for (const id of graph.order) {
    results.set(id, { status: "pending" });
    const count = graph.deps.get(id)!.length;
    remainingDeps.set(id, count);
    if (count === 0) ready.push(id);
  }

  const startOrder: string[] = [];
  const started = new Set<string>();
  const outputs = new Map<string, unknown>();
  let running = 0;

  const cancelSuccessors = (id: string): void => {
    for (const dependent of graph.dependents.get(id)!) {
      const result = results.get(dependent)!;
      if (result.status !== "pending") {
        // Succeeded / running / failed nodes are never rolled back.
        continue;
      }
      result.status = "cancelled";
      cancelSuccessors(dependent);
    }
  };

  return new Promise<ExecutionReport>((resolve, reject) => {
    const pump = (): void => {
      while (ready.length > 0) {
        const id = ready.shift()!;
        if (results.get(id)!.status !== "pending") continue;
        start(id);
      }
      if (running === 0) {
        resolve({ results, startOrder });
      }
    };

    const start = (id: string): void => {
      if (started.has(id)) {
        reject(
          new ExecutorInvariantError(`Task "${id}" started more than once`),
        );
        return;
      }
      started.add(id);
      startOrder.push(id);
      const result = results.get(id)!;
      result.status = "running";
      running += 1;

      const ctx: TaskContext = {
        id,
        outputOf(depId: string): unknown {
          if (!graph.deps.get(id)!.includes(depId)) {
            throw new Error(`"${depId}" is not a dependency of "${id}"`);
          }
          return outputs.get(depId);
        },
      };

      let settled: Promise<unknown>;
      try {
        settled = Promise.resolve(graph.tasks.get(id)!.run(ctx));
      } catch (error) {
        settled = Promise.reject(error);
      }

      settled.then(
        (value) => {
          running -= 1;
          result.status = "succeeded";
          result.value = value;
          outputs.set(id, value);
          for (const dependent of graph.dependents.get(id)!) {
            const left = remainingDeps.get(dependent)! - 1;
            remainingDeps.set(dependent, left);
            if (left === 0 && results.get(dependent)!.status === "pending") {
              ready.push(dependent);
            }
          }
          pump();
        },
        (error) => {
          running -= 1;
          result.status = "failed";
          result.error = error;
          cancelSuccessors(id);
          pump();
        },
      );
    };

    pump();
  });
}
