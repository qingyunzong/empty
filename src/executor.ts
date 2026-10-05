/**
 * Controllable executor: exposes its ready set, runs one case per `step()`,
 * and derives readiness incrementally from remaining-dependency counters.
 */

import {
  buildGraph,
  classifyGraph,
  type GraphModel,
  type TestCaseDef,
} from "./graph.js";

export type CaseStatus =
  | "pending"
  | "ready"
  | "passed"
  | "failed"
  | "cancelled"
  | "isolated";

export interface CaseResult {
  id: string;
  status: CaseStatus;
  error?: string;
}

/** Throws (or rejects) to fail the case; returns normally to pass it. */
export type Runner = (id: string) => void | Promise<void>;

export interface ExecutorOptions {
  run?: Runner;
}

const TERMINAL: ReadonlySet<CaseStatus> = new Set([
  "passed",
  "failed",
  "cancelled",
  "isolated",
]);

export class ControllableExecutor {
  private readonly graph: GraphModel;
  private readonly status = new Map<string, CaseStatus>();
  private readonly errors = new Map<string, string>();
  private readonly remainingDeps = new Map<string, number>();
  private readonly run: Runner;

  constructor(defs: readonly TestCaseDef[], options: ExecutorOptions = {}) {
    this.graph = buildGraph(defs);
    const classification = classifyGraph(this.graph);
    this.run = options.run ?? (() => {});
    for (const id of this.graph.ids) {
      if (classification.isolated.has(id)) {
        this.status.set(id, "isolated");
        this.remainingDeps.set(id, Number.POSITIVE_INFINITY);
      } else {
        const count = this.graph.deps.get(id)!.length;
        this.remainingDeps.set(id, count);
        this.status.set(id, count === 0 ? "ready" : "pending");
      }
    }
  }

  /** Currently runnable cases, sorted by id. */
  readySet(): string[] {
    return this.graph.ids
      .filter((id) => this.status.get(id) === "ready")
      .sort();
  }

  /** Start set as seen by the executor's incremental state machine. */
  startSet(): string[] {
    return this.readySet();
  }

  isSettled(): boolean {
    return this.readySet().length === 0;
  }

  /** Runs the lowest-id ready case. Returns its id, or null when none ready. */
  async step(): Promise<string | null> {
    const next = this.readySet()[0];
    if (next === undefined) return null;
    await this.runCase(next);
    return next;
  }

  async runAll(): Promise<void> {
    while ((await this.step()) !== null) {
      // drain
    }
  }

  private async runCase(id: string): Promise<void> {
    try {
      await this.run(id);
      this.status.set(id, "passed");
      for (const dependent of this.graph.dependents.get(id)!) {
        if (this.status.get(dependent) !== "pending") continue;
        const remaining = this.remainingDeps.get(dependent)! - 1;
        this.remainingDeps.set(dependent, remaining);
        if (remaining === 0) this.status.set(dependent, "ready");
      }
    } catch (error) {
      this.status.set(id, "failed");
      this.errors.set(
        id,
        error instanceof Error ? error.message : String(error),
      );
      this.cancelDownstream(id);
    }
  }

  /**
   * Failure cancels transitive dependents only. Siblings (cases sharing a
   * prerequisite with the failed case) are never touched.
   */
  private cancelDownstream(id: string): void {
    for (const dependent of this.graph.dependents.get(id)!) {
      const current = this.status.get(dependent)!;
      if (TERMINAL.has(current)) continue;
      this.status.set(dependent, "cancelled");
      this.cancelDownstream(dependent);
    }
  }

  /** Final snapshot, always sorted by case id for stable output. */
  results(): CaseResult[] {
    return [...this.graph.ids].sort().map((id) => {
      const status = this.status.get(id)!;
      const error = this.errors.get(id);
      return error === undefined ? { id, status } : { id, status, error };
    });
  }
}

/** Deterministic one-line-per-case rendering of sorted results. */
export function formatResults(results: readonly CaseResult[]): string {
  return results
    .map((r) => `${r.id}\t${r.status}${r.error === undefined ? "" : `\t${r.error}`}`)
    .join("\n");
}
