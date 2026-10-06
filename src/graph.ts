/**
 * Dependency-aware step graph runner with saga-style compensation.
 *
 * Semantics:
 * - Steps run sequentially in a deterministic topological order
 *   (dependencies first; ties broken by definition order).
 * - If any step fails, or the run is cancelled, exactly the steps that
 *   succeeded AND define `compensate` are rolled back, in reverse
 *   dependency order (dependents before their dependencies).
 * - Every `execute` and every `compensate` runs at most once per run.
 * - Compensation failures never silently pass: they are aggregated into
 *   a `CompensationError` (an `AggregateError`) whose `cause` is the
 *   original failure, so a failed rollback is never reported as success.
 */

export const StepStatus = {
  Pending: "pending",
  Running: "running",
  Succeeded: "succeeded",
  Failed: "failed",
  Compensated: "compensated",
  CompensationFailed: "compensationFailed",
} as const;

export type StepStatus = (typeof StepStatus)[keyof typeof StepStatus];

export interface StepContext {
  /** Aborted when the run is cancelled; steps should cooperate. */
  readonly signal: AbortSignal;
  /** Outputs of steps that have already succeeded, keyed by step name. */
  readonly outputs: ReadonlyMap<string, unknown>;
}

export interface StepDefinition<TOutput = unknown> {
  readonly name: string;
  readonly dependsOn?: readonly string[];
  execute(ctx: StepContext): TOutput | Promise<TOutput>;
  compensate?(output: TOutput, ctx: StepContext): void | Promise<void>;
}

export interface RunOptions {
  /** Cancelling this signal triggers the same compensation rules as a failure. */
  readonly signal?: AbortSignal;
}

export class GraphValidationError extends Error {
  override readonly name = "GraphValidationError";
}

export class CancelledError extends Error {
  override readonly name = "CancelledError";
  constructor(message = "Step graph run was cancelled") {
    super(message);
  }
}

export interface CompensationFailure {
  readonly step: string;
  readonly error: unknown;
}

/**
 * Thrown when the run failed (or was cancelled) AND at least one
 * compensation also failed. Never resolved silently: `cause` holds the
 * original failure and `errors`/`failures` hold every compensation error.
 */
export class CompensationError extends AggregateError {
  override readonly name = "CompensationError";
  readonly failures: readonly CompensationFailure[];

  constructor(failures: readonly CompensationFailure[], cause: unknown) {
    super(
      failures.map((f) => f.error),
      `Rollback incomplete: ${failures.length} compensation(s) failed for step(s): ` +
        failures.map((f) => f.step).join(", "),
      { cause },
    );
    this.failures = failures;
  }
}

export interface RunResult {
  /** Outputs of all succeeded steps (only present on full success). */
  readonly outputs: ReadonlyMap<string, unknown>;
}

function validateGraph(steps: readonly StepDefinition[]): void {
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.name)) {
      throw new GraphValidationError(`Duplicate step name: "${step.name}"`);
    }
    seen.add(step.name);
  }
  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!seen.has(dep)) {
        throw new GraphValidationError(
          `Step "${step.name}" depends on unknown step "${dep}"`,
        );
      }
      if (dep === step.name) {
        throw new GraphValidationError(`Step "${step.name}" depends on itself`);
      }
    }
  }
}

/**
 * Deterministic topological order: repeatedly pick the first step (in
 * definition order) whose dependencies are all already ordered.
 */
function topoSort(steps: readonly StepDefinition[]): StepDefinition[] {
  const ordered: StepDefinition[] = [];
  const placed = new Set<string>();
  const remaining = [...steps];
  while (remaining.length > 0) {
    const index = remaining.findIndex((step) =>
      (step.dependsOn ?? []).every((dep) => placed.has(dep)),
    );
    if (index === -1) {
      throw new GraphValidationError(
        `Dependency cycle detected involving: ${remaining
          .map((s) => `"${s.name}"`)
          .join(", ")}`,
      );
    }
    const [next] = remaining.splice(index, 1);
    ordered.push(next!);
    placed.add(next!.name);
  }
  return ordered;
}

export async function runSteps(
  steps: readonly StepDefinition[],
  options: RunOptions = {},
): Promise<RunResult> {
  validateGraph(steps);
  const order = topoSort(steps);
  const signal = options.signal ?? new AbortController().signal;

  const outputs = new Map<string, unknown>();
  const status = new Map<string, StepStatus>(
    order.map((s) => [s.name, StepStatus.Pending]),
  );
  const ctx: StepContext = { signal, outputs };
  const succeeded: StepDefinition[] = [];

  const throwIfAborted = (): void => {
    if (signal.aborted) throw new CancelledError();
  };

  let failure: unknown;
  try {
    for (const step of order) {
      throwIfAborted();
      status.set(step.name, StepStatus.Running);
      try {
        const output = await step.execute(ctx);
        outputs.set(step.name, output);
        status.set(step.name, StepStatus.Succeeded);
        succeeded.push(step);
      } catch (err) {
        status.set(step.name, StepStatus.Failed);
        throw err;
      }
    }
    // A cancellation that landed while the final step was in-flight must
    // still trigger compensation instead of reporting success.
    throwIfAborted();
    return { outputs };
  } catch (err) {
    failure = err;
  }

  // Compensation phase: identical rules for failures and cancellation.
  // Only steps that succeeded and are compensable, in reverse dependency
  // order (reverse completion order). Each compensation runs at most once.
  const compensationFailures: CompensationFailure[] = [];
  for (const step of [...succeeded].reverse()) {
    if (status.get(step.name) !== StepStatus.Succeeded) continue;
    if (!step.compensate) continue;
    try {
      await step.compensate(outputs.get(step.name), ctx);
      status.set(step.name, StepStatus.Compensated);
    } catch (err) {
      status.set(step.name, StepStatus.CompensationFailed);
      compensationFailures.push({ step: step.name, error: err });
    }
  }

  if (compensationFailures.length > 0) {
    throw new CompensationError(compensationFailures, failure);
  }
  throw failure;
}
