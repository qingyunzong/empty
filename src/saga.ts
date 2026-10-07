export interface StepContext {
  signal: AbortSignal;
}

export interface Step {
  id: string;
  dependsOn?: readonly string[];
  run(ctx: StepContext): Promise<void> | void;
  compensate?(ctx: StepContext): Promise<void> | void;
}

export class CancelledError extends Error {
  constructor(message = "saga cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

export class SagaError extends Error {
  readonly cause: unknown;
  readonly compensationErrors: readonly unknown[];

  constructor(cause: unknown, compensationErrors: readonly unknown[]) {
    const base = cause instanceof Error ? cause.message : String(cause);
    const suffix =
      compensationErrors.length > 0
        ? `; rollback incomplete: ${compensationErrors.length} compensation(s) failed`
        : "; rollback completed";
    super(`saga failed: ${base}${suffix}`);
    this.name = "SagaError";
    this.cause = cause;
    this.compensationErrors = compensationErrors;
  }
}

interface StepState {
  step: Step;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
}

export class Saga {
  private readonly states = new Map<string, StepState>();
  private readonly order: Step[];
  private readonly controller = new AbortController();

  constructor(steps: readonly Step[]) {
    for (const step of steps) {
      if (this.states.has(step.id)) {
        throw new Error(`duplicate step id: ${step.id}`);
      }
      this.states.set(step.id, { step, status: "pending" });
    }
    for (const step of steps) {
      for (const dep of step.dependsOn ?? []) {
        if (!this.states.has(dep)) {
          throw new Error(`step "${step.id}" depends on unknown step "${dep}"`);
        }
      }
    }
    this.order = topoSort(steps);
  }

  cancel(): void {
    this.controller.abort();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  async execute(): Promise<void> {
    const ctx: StepContext = { signal: this.controller.signal };
    let failure: unknown = null;

    for (const step of this.order) {
      const state = this.states.get(step.id)!;
      if (failure !== null || this.controller.signal.aborted) {
        state.status = "skipped";
        continue;
      }
      const depsFailed = (step.dependsOn ?? []).some(
        (dep) => this.states.get(dep)!.status !== "succeeded",
      );
      if (depsFailed) {
        state.status = "skipped";
        continue;
      }
      state.status = "running";
      try {
        await step.run(ctx);
        state.status = "succeeded";
      } catch (err) {
        state.status = "failed";
        failure = err;
      }
    }

    if (failure === null && this.controller.signal.aborted) {
      failure = new CancelledError();
    }
    if (failure === null) return;

    throw new SagaError(failure, await this.compensate(ctx));
  }

  private async compensate(ctx: StepContext): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const step of [...this.order].reverse()) {
      const state = this.states.get(step.id)!;
      if (state.status !== "succeeded" || !step.compensate) continue;
      try {
        await step.compensate(ctx);
      } catch (err) {
        errors.push(err);
      }
    }
    return errors;
  }
}

function topoSort(steps: readonly Step[]): Step[] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const step of steps) {
    indegree.set(step.id, step.dependsOn?.length ?? 0);
    for (const dep of step.dependsOn ?? []) {
      const list = dependents.get(dep) ?? [];
      list.push(step.id);
      dependents.set(dep, list);
    }
  }
  const byId = new Map(steps.map((s) => [s.id, s]));
  const queue = steps.filter((s) => indegree.get(s.id) === 0).map((s) => s.id);
  const order: Step[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(byId.get(id)!);
    for (const next of dependents.get(id) ?? []) {
      const remaining = indegree.get(next)! - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  if (order.length !== steps.length) {
    throw new Error("dependency cycle detected");
  }
  return order;
}
