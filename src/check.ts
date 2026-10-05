import { Arbitrary } from "./arbitrary.js";
import { Seed, caseRng } from "./rng.js";
import { Tree } from "./tree.js";

/** How a single property evaluation ended. */
export type Outcome = "pass" | "failure" | "exception";

export interface TraceEntry {
  /** Global evaluation counter (0-based) across generation and shrinking. */
  index: number;
  phase: "generate" | "shrink";
  /** Serialized candidate value. */
  value: string;
  outcome: Outcome;
  /** Error message when outcome is "exception". */
  error?: string;
}

export interface CheckParams<T> {
  arb: Arbitrary<T>;
  /**
   * The property under test.
   *  - return `false`            -> failure   (plain falsification)
   *  - throw                     -> exception (the test itself blew up)
   *  - return `true`/`undefined` -> pass
   */
  property: (value: T) => boolean | void;
  seed?: Seed;
  numRuns?: number;
  /** Budget of shrink evaluations before pausing with a checkpoint. */
  maxShrinkSteps?: number;
  /** Stable serialization for candidate dedup; defaults to JSON. */
  serialize?: (value: T) => string;
}

export interface CheckResult<T> {
  status: "passed" | "failed" | "error";
  seed: Seed;
  numRuns: number;
  /** Total property evaluations (generation + shrinking). */
  evaluations: number;
  /** Every evaluated candidate, in order. */
  trace: TraceEntry[];
  /** Present when status is "failed" or "error". */
  counterexample?: T;
  /** Kind of the final counterexample: falsified vs. threw. */
  counterexampleKind?: "failure" | "exception";
  errorMessage?: string;
  shrinkSteps: number;
  /**
   * True when no direct child of the final counterexample fails — i.e. the
   * result cannot be shrunk by a single step.
   */
  isMinimal: boolean;
  /** Serialized pause state when the shrink budget ran out. */
  checkpoint?: string;
}

export interface Checkpoint {
  seed: Seed;
  runIndex: number;
  /** Child indices from the case root to the current shrink node. */
  path: number[];
  /** Serialized candidates already evaluated (never re-tested on resume). */
  tested: string[];
  /** Outcome of the current node, so resume never re-evaluates it. */
  nodeOutcome: { outcome: Outcome; error?: string };
  evaluations: number;
  trace: TraceEntry[];
}

export function serializeCheckpoint(cp: Checkpoint): string {
  return JSON.stringify(cp);
}

export function parseCheckpoint(s: string): Checkpoint {
  return JSON.parse(s) as Checkpoint;
}

function defaultSerialize(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    if (s !== undefined) return s;
  } catch {
    /* fall through */
  }
  return String(v);
}

function classify<T>(
  property: (v: T) => boolean | void,
  value: T,
): { outcome: Outcome; error?: string } {
  try {
    const r = property(value);
    return r === false ? { outcome: "failure" } : { outcome: "pass" };
  } catch (err) {
    return { outcome: "exception", error: err instanceof Error ? err.message : String(err) };
  }
}

interface Eval {
  (v: unknown, phase: "generate" | "shrink"): { outcome: Outcome; error?: string };
}

interface ShrinkState {
  node: Tree<unknown>;
  nodeOutcome: { outcome: Outcome; error?: string };
  path: number[];
  tested: Set<string>;
  steps: number;
  done: boolean;
}

function makeEvaluator<T>(
  property: (v: T) => boolean | void,
  serialize: (v: T) => string,
  trace: TraceEntry[],
  counter: { n: number },
): Eval {
  return (v, phase) => {
    const r = classify(property, v as T);
    trace.push({
      index: counter.n,
      phase,
      value: serialize(v as T),
      outcome: r.outcome,
      ...(r.error !== undefined ? { error: r.error } : {}),
    });
    counter.n++;
    return r;
  };
}

export function check<T>(params: CheckParams<T>): CheckResult<T> {
  const seed = params.seed ?? (Date.now() % 0x7fffffff);
  const numRuns = params.numRuns ?? 100;
  const serialize = params.serialize ?? defaultSerialize;
  const trace: TraceEntry[] = [];
  const counter = { n: 0 };
  const evaluate = makeEvaluator(params.property, serialize, trace, counter);

  for (let runIndex = 0; runIndex < numRuns; runIndex++) {
    const caseTree = params.arb.generate(caseRng(seed, runIndex));
    const rootOutcome = evaluate(caseTree.value, "generate");
    if (rootOutcome.outcome === "pass") continue;

    const state: ShrinkState = {
      node: caseTree as Tree<unknown>,
      nodeOutcome: rootOutcome,
      path: [],
      tested: new Set([serialize(caseTree.value)]),
      steps: 0,
      done: false,
    };
    shrinkLoop(state, evaluate, serialize as (v: unknown) => string, params.maxShrinkSteps ?? Infinity);

    const result = buildResult<T>(seed, numRuns, trace, counter.n, state);
    if (!state.done) {
      result.checkpoint = serializeCheckpoint({
        seed, runIndex, path: state.path, tested: [...state.tested],
        nodeOutcome: state.nodeOutcome, evaluations: counter.n, trace,
      });
    }
    return result;
  }

  return { status: "passed", seed, numRuns, evaluations: counter.n, trace, shrinkSteps: 0, isMinimal: true };
}

/**
 * Resume a paused shrink from a checkpoint. The same case tree is
 * regenerated deterministically from (seed, runIndex); candidates recorded
 * in the checkpoint are never evaluated again.
 */
export function resume<T>(params: CheckParams<T>, checkpoint: string | Checkpoint): CheckResult<T> {
  const cp = typeof checkpoint === "string" ? parseCheckpoint(checkpoint) : checkpoint;
  const serialize = params.serialize ?? defaultSerialize;
  const trace: TraceEntry[] = [...cp.trace];
  const counter = { n: cp.evaluations };
  const evaluate = makeEvaluator(params.property, serialize, trace, counter);

  const caseTree = params.arb.generate(caseRng(cp.seed, cp.runIndex));
  let node = caseTree as Tree<unknown>;
  for (const idx of cp.path) {
    const children = [...node.children()];
    const next = children[idx];
    if (!next) throw new Error(`checkpoint path does not match regenerated tree at depth ${idx}`);
    node = next;
  }

  const state: ShrinkState = {
    node,
    nodeOutcome: cp.nodeOutcome,
    path: [...cp.path],
    tested: new Set(cp.tested),
    steps: 0,
    done: false,
  };
  shrinkLoop(state, evaluate, serialize as (v: unknown) => string, params.maxShrinkSteps ?? Infinity);

  const result = buildResult<T>(cp.seed, params.numRuns ?? 100, trace, counter.n, state);
  if (!state.done) {
    result.checkpoint = serializeCheckpoint({
      seed: cp.seed, runIndex: cp.runIndex, path: state.path, tested: [...state.tested],
      nodeOutcome: state.nodeOutcome, evaluations: counter.n, trace,
    });
  }
  return result;
}

/**
 * Greedy single-step shrinking: repeatedly move to the first failing child.
 * Stops only when no direct child fails, so the result is guaranteed to be
 * irreducible by one step. The `tested` set dedups candidates across the
 * whole session and across resume boundaries via the checkpoint.
 */
function shrinkLoop(
  state: ShrinkState,
  evaluate: Eval,
  serialize: (v: unknown) => string,
  budget: number,
): void {
  outer: for (;;) {
    let childIndex = -1;
    for (const child of state.node.children()) {
      childIndex++;
      const key = serialize(child.value);
      if (state.tested.has(key)) continue;
      state.tested.add(key);
      if (state.steps >= budget) return; // paused; checkpoint carries `tested`
      state.steps++;
      const r = evaluate(child.value, "shrink");
      if (r.outcome !== "pass") {
        state.node = child;
        state.nodeOutcome = r;
        state.path.push(childIndex);
        continue outer;
      }
    }
    state.done = true;
    return;
  }
}

function buildResult<T>(
  seed: Seed,
  numRuns: number,
  trace: TraceEntry[],
  evaluations: number,
  state: ShrinkState,
): CheckResult<T> {
  const kind = state.nodeOutcome.outcome === "exception" ? "exception" : "failure";
  return {
    status: kind === "exception" ? "error" : "failed",
    seed,
    numRuns,
    evaluations,
    trace,
    counterexample: state.node.value as T,
    counterexampleKind: kind,
    ...(state.nodeOutcome.error !== undefined ? { errorMessage: state.nodeOutcome.error } : {}),
    shrinkSteps: state.steps,
    isMinimal: state.done,
  };
}
