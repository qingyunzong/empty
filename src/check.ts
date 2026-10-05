// Property check runner.
//
// A property returns `false` to falsify (a genuine counterexample) or
// throws to signal a test exception. The two are reported as distinct
// statuses ("falsified" vs "error") and shrunk with matching notions of
// "still interesting".

import { Arbitrary } from "./arbitrary";
import { Rng, deriveSeed, randomSeedString } from "./rng";
import {
  Outcome,
  ShrinkCheckpoint,
  TraceEntry,
  shrink,
} from "./shrink";

export type Property<T> = (value: T) => boolean | void;

export interface CheckOptions<T> {
  seed?: string;
  numRuns?: number;
  size?: number;
  maxShrinkTests?: number;
  onCheckpoint?: (cp: ShrinkCheckpoint<T>) => void;
}

export interface CheckReport<T> {
  status: "passed" | "falsified" | "error";
  seed: string;
  numRuns: number;
  trace: TraceEntry[];
  counterexample?: T;
  minimal?: T;
  shrinkSteps?: number;
  shrinkTestsRun?: number;
  shrinkComplete?: boolean;
  error?: { message: string };
  checkpoint?: ShrinkCheckpoint<T>;
}

interface EvalResult {
  kind: Outcome;
  error?: string;
}

function evalProperty<T>(property: Property<T>, value: T): EvalResult {
  try {
    const r = property(value);
    return r === false ? { kind: "fail" } : { kind: "pass" };
  } catch (e) {
    return { kind: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

export function check<T>(
  arb: Arbitrary<T>,
  property: Property<T>,
  opts: CheckOptions<T> = {},
): CheckReport<T> {
  const numRuns = opts.numRuns ?? 100;
  const size = opts.size ?? 10;
  const seed = opts.seed ?? randomSeedString();
  const trace: TraceEntry[] = [];
  let step = 0;

  for (let run = 0; run < numRuns; run++) {
    const rng = new Rng(deriveSeed(seed, run));
    let value: T;
    try {
      value = arb.generate(rng, size);
    } catch (e) {
      return {
        status: "error",
        seed,
        numRuns,
        trace,
        error: {
          message: `generation failed at run ${run}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        },
      };
    }
    const res = evalProperty(property, value);
    trace.push({
      phase: "generate",
      step: step++,
      value,
      outcome: res.kind,
      ...(res.error ? { note: res.error } : {}),
    });
    if (res.kind === "pass") continue;

    const kind = res.kind;
    const isInteresting = (v: T) => evalProperty(property, v).kind === kind;
    const result = shrink(arb, isInteresting, value, {
      seed,
      kind,
      maxTests: opts.maxShrinkTests,
      onCheckpoint: opts.onCheckpoint,
    });
    trace.push(...result.trace);

    const report: CheckReport<T> = {
      status: kind === "fail" ? "falsified" : "error",
      seed,
      numRuns,
      trace,
      counterexample: value,
      minimal: result.minimal,
      shrinkSteps: result.steps,
      shrinkTestsRun: result.testsRun,
      shrinkComplete: result.complete,
      checkpoint: result.checkpoint,
    };
    if (kind === "error") report.error = { message: res.error ?? "unknown" };
    return report;
  }

  return { status: "passed", seed, numRuns, trace };
}
