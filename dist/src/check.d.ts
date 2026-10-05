import { Arbitrary } from "./arbitrary.js";
import { Seed } from "./rng.js";
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
    nodeOutcome: {
        outcome: Outcome;
        error?: string;
    };
    evaluations: number;
    trace: TraceEntry[];
}
export declare function serializeCheckpoint(cp: Checkpoint): string;
export declare function parseCheckpoint(s: string): Checkpoint;
export declare function check<T>(params: CheckParams<T>): CheckResult<T>;
/**
 * Resume a paused shrink from a checkpoint. The same case tree is
 * regenerated deterministically from (seed, runIndex); candidates recorded
 * in the checkpoint are never evaluated again.
 */
export declare function resume<T>(params: CheckParams<T>, checkpoint: string | Checkpoint): CheckResult<T>;
