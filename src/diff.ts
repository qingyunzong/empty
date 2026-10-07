import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Plan, PlanScheduler, flushMicrotasks } from './scheduler';
import { JobQueue, Op, canonical } from './sut';

/** A divergence is bound to the exact sources that produced it. */
export interface SourceBinding {
  name: string;
  file: string;
  sha256: string;
}

export function bindSource(name: string, file: string): SourceBinding {
  const sha256 = createHash('sha256')
    .update(readFileSync(file, 'utf8'))
    .digest('hex');
  return { name, file, sha256 };
}

export type DivergenceKind = 'result' | 'state' | 'events';

export interface Divergence {
  kind: DivergenceKind;
  /** Index of the op after which the divergence was observed. */
  opIndex: number;
  op: Op;
  /** Canonical JSON of side A's observation. */
  a: string;
  /** Canonical JSON of side B's observation. */
  b: string;
}

export function divergenceSignature(d: Divergence): string {
  return `${d.kind}|${d.a}|${d.b}`;
}

export interface DiffReport {
  ok: boolean;
  plan: Plan;
  sources: { a: SourceBinding; b: SourceBinding };
  opsExecuted: number;
  divergence: Divergence | null;
  /**
   * Shortest prefix of the op sequence that reproduces the divergence.
   * Re-verified by re-running; null when the run is clean.
   */
  minimalPrefix: Op[] | null;
  /**
   * Settlements still outstanding when the sequence ended.
   * Recorded for transparency — unfinished work is NOT a failure.
   */
  pendingAtEnd: { a: number; b: number };
}

export interface DiffTarget {
  binding: SourceBinding;
  make: (scheduler: PlanScheduler) => JobQueue;
}

export interface DiffInput {
  ops: Op[];
  plan: Plan;
  a: DiffTarget;
  b: DiffTarget;
}

interface Side {
  queue: JobQueue;
  scheduler: PlanScheduler;
}

function applyOp(side: Side, op: Op): unknown {
  switch (op.kind) {
    case 'submit':
      return side.queue.submit(op.name);
    case 'cancel':
      return side.queue.cancel(op.id);
    case 'status':
      return side.queue.status(op.id);
    case 'tick':
      side.scheduler.advance();
      return null;
  }
}

interface RunOutcome {
  divergence: Divergence | null;
  opsExecuted: number;
}

async function run(ops: Op[], a: Side, b: Side): Promise<RunOutcome> {
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    const resultA = applyOp(a, op);
    const resultB = applyOp(b, op);
    await flushMicrotasks();

    if (canonical(resultA) !== canonical(resultB)) {
      return {
        divergence: { kind: 'result', opIndex: i, op, a: canonical(resultA), b: canonical(resultB) },
        opsExecuted: i + 1,
      };
    }
    const eventsA = a.queue.drainEvents();
    const eventsB = b.queue.drainEvents();
    if (canonical(eventsA) !== canonical(eventsB)) {
      return {
        divergence: { kind: 'events', opIndex: i, op, a: canonical(eventsA), b: canonical(eventsB) },
        opsExecuted: i + 1,
      };
    }
    const stateA = canonical(a.queue.snapshot());
    const stateB = canonical(b.queue.snapshot());
    if (stateA !== stateB) {
      return {
        divergence: { kind: 'state', opIndex: i, op, a: stateA, b: stateB },
        opsExecuted: i + 1,
      };
    }
  }
  // Unfinished (still-pending) settlements at end of sequence are reported
  // by the caller but never treated as a divergence.
  return { divergence: null, opsExecuted: ops.length };
}

/**
 * Drive both implementations with the same op sequence under the same plan,
 * comparing op results, canonical state, and event order after every step.
 */
export async function runDifferential(input: DiffInput): Promise<DiffReport> {
  const schedulerA = new PlanScheduler(input.plan);
  const schedulerB = new PlanScheduler(input.plan);
  const a: Side = { queue: input.a.make(schedulerA), scheduler: schedulerA };
  const b: Side = { queue: input.b.make(schedulerB), scheduler: schedulerB };

  const outcome = await run(input.ops, a, b);

  const report: DiffReport = {
    ok: outcome.divergence === null,
    plan: input.plan,
    sources: { a: input.a.binding, b: input.b.binding },
    opsExecuted: outcome.opsExecuted,
    divergence: outcome.divergence,
    minimalPrefix: null,
    pendingAtEnd: { a: schedulerA.pending, b: schedulerB.pending },
  };

  if (outcome.divergence) {
    report.minimalPrefix = await minimizePrefix(input, outcome.divergence);
  }
  return report;
}

/**
 * The first divergence at index k makes ops[0..k] the shortest reproducing
 * prefix. Re-run that prefix to confirm it deterministically reproduces the
 * same divergence signature before reporting it.
 */
async function minimizePrefix(input: DiffInput, first: Divergence): Promise<Op[]> {
  const prefix = input.ops.slice(0, first.opIndex + 1);
  const schedulerA = new PlanScheduler(input.plan);
  const schedulerB = new PlanScheduler(input.plan);
  const a: Side = { queue: input.a.make(schedulerA), scheduler: schedulerA };
  const b: Side = { queue: input.b.make(schedulerB), scheduler: schedulerB };
  const rerun = await run(prefix, a, b);
  if (
    rerun.divergence &&
    rerun.divergence.opIndex === first.opIndex &&
    divergenceSignature(rerun.divergence) === divergenceSignature(first)
  ) {
    return prefix;
  }
  // Deterministic scheduler + pure ops should always reproduce; fail loudly.
  throw new Error('divergence did not reproduce from minimal prefix');
}
