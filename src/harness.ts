import { generateOps, hashOps, serializeOps, type Op } from "./ops";
import { Scheduler, flushMicrotasks } from "./scheduler";
import type { JobQueueFactory, JobResult } from "./subject";

// Per-step observation. `results` maps the submitting op index to a canonical
// outcome: "pending" while unsettled (NOT a failure), or a settled value.
export interface StepRecord {
  state: string;
  results: string;
  events: string;
}

export interface RunTrace {
  steps: StepRecord[];
}

export type DivergenceKind = "state" | "result" | "event";

export interface Divergence {
  index: number;
  kinds: DivergenceKind[];
  a: StepRecord;
  b: StepRecord;
}

export interface DiffReport {
  ok: false;
  seed: number;
  sourceHash: string;
  divergence: Divergence;
  minimalPrefix: Op[];
  minimalHash: string;
}

export interface OkReport {
  ok: true;
  seed: number;
  sourceHash: string;
  steps: number;
}

export type DiffResult = OkReport | DiffReport;

export async function runOps(factory: JobQueueFactory, ops: readonly Op[]): Promise<RunTrace> {
  const scheduler = new Scheduler();
  const queue = factory(scheduler);
  const outcomes = new Map<number, string>();
  const events: string[] = [];
  const steps: StepRecord[] = [];

  queue.onEvent((event) => {
    events.push(`${event.type}:${event.id}`);
  });

  const recordStep = (): void => {
    const results = [...outcomes.entries()]
      .sort(([a], [b]) => a - b)
      .map(([opIndex, outcome]) => `#${opIndex}=${outcome}`)
      .join(",");
    steps.push({ state: queue.snapshot(), results, events: events.join(",") });
  };

  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i] as Op;
    switch (op.kind) {
      case "submit": {
        outcomes.set(i, "pending");
        const promise = queue.submit(op.id);
        promise.then(
          (result: JobResult) => outcomes.set(i, `resolved:${result.id}:${result.status}`),
          (error: unknown) => outcomes.set(i, `rejected:${String(error)}`),
        );
        break;
      }
      case "cancel": {
        const cancelled = queue.cancel(op.id);
        outcomes.set(i, `returned:${cancelled}`);
        break;
      }
      case "pump": {
        scheduler.pump(op.steps);
        break;
      }
    }
    await flushMicrotasks();
    recordStep();
  }

  return { steps };
}

export function firstDivergence(a: RunTrace, b: RunTrace): Divergence | null {
  const length = Math.min(a.steps.length, b.steps.length);
  for (let i = 0; i < length; i += 1) {
    const stepA = a.steps[i] as StepRecord;
    const stepB = b.steps[i] as StepRecord;
    const kinds: DivergenceKind[] = [];
    if (stepA.state !== stepB.state) kinds.push("state");
    if (stepA.results !== stepB.results) kinds.push("result");
    if (stepA.events !== stepB.events) kinds.push("event");
    if (kinds.length > 0) return { index: i, kinds, a: stepA, b: stepB };
  }
  return null;
}

async function diverges(
  factoryA: JobQueueFactory,
  factoryB: JobQueueFactory,
  ops: readonly Op[],
): Promise<boolean> {
  const [traceA, traceB] = await Promise.all([runOps(factoryA, ops), runOps(factoryB, ops)]);
  return firstDivergence(traceA, traceB) !== null;
}

// Greedy 1-minimal shrinking: start from the prefix up to the first
// divergence, then repeatedly drop any op whose removal still reproduces a
// divergence. Deterministic, so the minimal prefix is reproducible.
export async function shrinkToMinimalPrefix(
  factoryA: JobQueueFactory,
  factoryB: JobQueueFactory,
  ops: readonly Op[],
  divergenceIndex: number,
): Promise<Op[]> {
  let current = ops.slice(0, divergenceIndex + 1);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < current.length; i += 1) {
      const candidate = current.filter((_, j) => j !== i);
      if (candidate.length === 0) continue;
      if (await diverges(factoryA, factoryB, candidate)) {
        current = candidate;
        changed = true;
        break;
      }
    }
  }
  return current;
}

export async function differentialTest(
  factoryA: JobQueueFactory,
  factoryB: JobQueueFactory,
  seed: number,
  opCount: number,
): Promise<DiffResult> {
  const ops = generateOps(seed, opCount);
  const sourceHash = hashOps(ops);
  const [traceA, traceB] = await Promise.all([runOps(factoryA, ops), runOps(factoryB, ops)]);
  const divergence = firstDivergence(traceA, traceB);
  if (divergence === null) {
    return { ok: true, seed, sourceHash, steps: ops.length };
  }
  const minimalPrefix = await shrinkToMinimalPrefix(factoryA, factoryB, ops, divergence.index);
  return {
    ok: false,
    seed,
    sourceHash,
    divergence,
    minimalPrefix,
    minimalHash: hashOps(minimalPrefix),
  };
}

export function formatReport(report: DiffResult): string {
  if (report.ok) {
    return `OK seed=${report.seed} hash=${report.sourceHash} steps=${report.steps}`;
  }
  const { divergence } = report;
  return [
    `DIFF seed=${report.seed} hash=${report.sourceHash}`,
    `first divergence at op ${divergence.index} (${divergence.kinds.join("+")})`,
    `  A: state=${divergence.a.state} results=${divergence.a.results} events=${divergence.a.events}`,
    `  B: state=${divergence.b.state} results=${divergence.b.results} events=${divergence.b.events}`,
    `minimal prefix (${report.minimalPrefix.length} ops, hash=${report.minimalHash}):`,
    `  ${serializeOps(report.minimalPrefix)}`,
  ].join("\n");
}
