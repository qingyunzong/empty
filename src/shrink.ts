// Greedy single-step shrinker.
//
// Termination guarantee: the loop only stops when no one-step shrink
// candidate of the current value is "interesting" anymore, so the
// returned value is single-step irreducible by construction.
//
// Resumability: every tested candidate is hashed (stable serialization)
// into `testedHashes`. A checkpoint is a plain JSON object; resuming
// from it skips any candidate whose hash was already tested, so no
// candidate is ever evaluated twice across sessions.

import { Arbitrary } from "./arbitrary";
import { hashValue } from "./hash";

export type Outcome = "pass" | "fail" | "error";
export type TraceOutcome = Outcome | "skip";

export interface TraceEntry {
  phase: "generate" | "shrink";
  step: number;
  value: unknown;
  outcome: TraceOutcome;
  note?: string;
}

export interface ShrinkCheckpoint<T> {
  version: 1;
  seed: string;
  kind: "fail" | "error";
  current: T;
  testedHashes: string[];
  steps: number;
  testsRun: number;
  complete: boolean;
  trace: TraceEntry[];
}

export interface ShrinkOptions<T> {
  seed?: string;
  kind?: "fail" | "error";
  resumeFrom?: ShrinkCheckpoint<T>;
  onCheckpoint?: (cp: ShrinkCheckpoint<T>) => void;
  maxTests?: number;
}

export interface ShrinkResult<T> {
  minimal: T;
  steps: number;
  testsRun: number;
  complete: boolean;
  trace: TraceEntry[];
  checkpoint: ShrinkCheckpoint<T>;
}

export function shrink<T>(
  arb: Arbitrary<T>,
  isInteresting: (value: T) => boolean,
  initial: T,
  opts: ShrinkOptions<T> = {},
): ShrinkResult<T> {
  const kind = opts.kind ?? opts.resumeFrom?.kind ?? "fail";
  const seed = opts.seed ?? opts.resumeFrom?.seed ?? "";
  const resume = opts.resumeFrom;

  const tested = new Set<string>(resume?.testedHashes ?? []);
  let current: T = resume ? resume.current : initial;
  let steps = resume?.steps ?? 0;
  let testsRun = 0;
  const trace: TraceEntry[] = resume ? resume.trace.map((e) => ({ ...e })) : [];
  tested.add(hashValue(current));
  let complete = false;
  let stepCounter = trace.length;

  const snapshot = (): ShrinkCheckpoint<T> => ({
    version: 1,
    seed,
    kind,
    current,
    testedHashes: [...tested],
    steps,
    testsRun: (resume?.testsRun ?? 0) + testsRun,
    complete,
    trace: trace.map((e) => ({ ...e })),
  });

  outer: while (true) {
    // Contract filter: candidates violating the input contract are never
    // tested and never descended into.
    const candidates = arb.shrink(current).filter((c) => arb.contract(c));
    for (const cand of candidates) {
      const h = hashValue(cand);
      if (tested.has(h)) {
        trace.push({
          phase: "shrink",
          step: stepCounter++,
          value: cand,
          outcome: "skip",
          note: "already tested",
        });
        continue;
      }
      if (opts.maxTests !== undefined && testsRun >= opts.maxTests) {
        break outer;
      }
      tested.add(h);
      testsRun++;
      const interesting = isInteresting(cand);
      trace.push({
        phase: "shrink",
        step: stepCounter++,
        value: cand,
        outcome: interesting ? kind : "pass",
      });
      if (interesting) {
        current = cand;
        steps++;
        opts.onCheckpoint?.(snapshot());
        continue outer;
      }
    }
    complete = true;
    break;
  }

  const checkpoint = snapshot();
  opts.onCheckpoint?.(checkpoint);
  return { minimal: current, steps, testsRun, complete, trace, checkpoint };
}

// Continue shrinking from a previously captured checkpoint.
// The checkpoint may be a JSON round-tripped object.
export function resumeShrink<T>(
  arb: Arbitrary<T>,
  isInteresting: (value: T) => boolean,
  checkpoint: ShrinkCheckpoint<T>,
  opts: Omit<ShrinkOptions<T>, "resumeFrom"> = {},
): ShrinkResult<T> {
  return shrink(arb, isInteresting, checkpoint.current, {
    ...opts,
    resumeFrom: checkpoint,
  });
}
