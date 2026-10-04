import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import {
  Sample, TailCount, enumerateNaive, enumerateCompressed, pValue,
  shiftSamples, MAX_CANDIDATES,
} from "./core.js";
import { Rat, cmp, parse, toString } from "./rational.js";

function canonicalSamples(samples: readonly Sample[]): string {
  return samples.map((s) => `${s.id}=${toString(s.diff)}`).join(";");
}

export function inputHash(samples: readonly Sample[]): string {
  return createHash("sha256").update(canonicalSamples(samples)).digest("hex");
}

export interface Certificate {
  readonly kind: "signflip-certificate-v1";
  readonly input: {
    readonly samples: ReadonlyArray<{ id: string; diff: string }>;
    readonly sha256: string;
  };
  readonly statistic: "abs(mean(paired differences))";
  readonly rule: "two-sided p = #{|sum(signed)| >= |observed sum|} / #assignments";
  readonly n: number;
  readonly zeroCount: number;
  readonly nonzeroCount: number;
  readonly observedSum: string;
  readonly observedStat: string;
  readonly countGE: string;
  readonly total: string;
  readonly p: string;
  readonly engines: {
    readonly naive: { countGE: string; total: string };
    readonly compressed: { countGE: string; total: string };
    readonly agree: boolean;
  };
  readonly digest: string;
}

/** Runs both engines on the same input and emits a counting certificate. */
export function certify(samples: readonly Sample[], tail: TailCount): Certificate {
  const cross = enumerateCompressed(samples);
  const agree = cross.countGE === tail.countGE && cross.total === tail.total;
  const body = {
    kind: "signflip-certificate-v1" as const,
    input: {
      samples: samples.map((s) => ({ id: s.id, diff: toString(s.diff) })),
      sha256: inputHash(samples),
    },
    statistic: "abs(mean(paired differences))" as const,
    rule: "two-sided p = #{|sum(signed)| >= |observed sum|} / #assignments" as const,
    n: samples.length,
    zeroCount: tail.zeroCount,
    nonzeroCount: tail.nonzeroCount,
    observedSum: toString(tail.observedSum),
    observedStat: toString(tail.observedStat),
    countGE: tail.countGE.toString(),
    total: tail.total.toString(),
    p: toString(pValue(tail)),
    engines: {
      naive: { countGE: tail.countGE.toString(), total: tail.total.toString() },
      compressed: { countGE: cross.countGE.toString(), total: cross.total.toString() },
      agree,
    },
  };
  const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return { ...body, digest };
}

interface CheckpointFile {
  version: 1;
  inputHash: string;
  nextMask: string;
  countGE: string;
  done: boolean;
}

/**
 * Resumable exact enumeration. Progress is persisted to `checkpointPath`
 * after every chunk; a later call with the same path and identical input
 * resumes where the previous run stopped. `maxChunks` bounds work per call
 * (used by tests and by interactive interruption).
 */
export function runWithCheckpoint(
  samples: readonly Sample[],
  checkpointPath: string,
  opts: { chunkSize?: number; maxChunks?: number } = {},
): { tail: TailCount; complete: boolean; resumed: boolean } {
  const hash = inputHash(samples);
  let startMask = 0n;
  let countGE = 0n;
  let resumed = false;
  if (existsSync(checkpointPath)) {
    const cp = JSON.parse(readFileSync(checkpointPath, "utf8")) as CheckpointFile;
    if (cp.version !== 1 || cp.inputHash !== hash) {
      throw new Error("checkpoint does not match input; refusing to resume");
    }
    if (cp.done) {
      unlinkSync(checkpointPath);
    } else {
      startMask = BigInt(cp.nextMask);
      countGE = BigInt(cp.countGE);
      resumed = true;
    }
  }
  let chunks = 0;
  const persist = (nextMask: bigint, ge: bigint, done: boolean) => {
    const cp: CheckpointFile = {
      version: 1, inputHash: hash,
      nextMask: nextMask.toString(), countGE: ge.toString(), done,
    };
    writeFileSync(checkpointPath, JSON.stringify(cp));
  };
  persist(startMask, countGE, false);
  const result = enumerateNaive(samples, {
    startMask,
    initialCountGE: countGE,
    chunkSize: opts.chunkSize,
    onChunk: (nextMask, ge) => {
      countGE = ge;
      persist(nextMask, ge, false);
      chunks++;
      return opts.maxChunks === undefined || chunks < opts.maxChunks;
    },
  });
  const tail = { ...result.tail, countGE };
  if (result.complete) {
    persist(result.nextMask, countGE, true);
    unlinkSync(checkpointPath);
  }
  return { tail, complete: result.complete, resumed };
}

export interface CandidateResult {
  readonly delta: string;
  readonly p: string;
  readonly countGE: string;
  readonly total: string;
  readonly inSet: boolean;
}

export interface ConfidenceSetResult {
  readonly alpha: string;
  readonly rule: "delta in set iff p_delta > alpha (strict)";
  readonly candidates: readonly CandidateResult[];
  readonly set: readonly string[];
  readonly certificates: readonly Certificate[];
}

/**
 * For each candidate shift delta, subtracts delta from every paired difference,
 * re-enumerates all sign flips, and keeps delta in the confidence set iff
 * p_delta > alpha (strict inequality, alpha rational).
 */
export function confidenceSet(
  samples: readonly Sample[],
  deltas: readonly string[],
  alpha: string,
  run: (s: readonly Sample[]) => { tail: TailCount } = (s) => ({
    tail: enumerateNaive(s).tail,
  }),
): ConfidenceSetResult {
  if (deltas.length > MAX_CANDIDATES) {
    throw new Error(`too many candidates: ${deltas.length} > ${MAX_CANDIDATES}`);
  }
  const a: Rat = parse(alpha);
  const candidates: CandidateResult[] = [];
  const set: string[] = [];
  const certificates: Certificate[] = [];
  for (const d of deltas) {
    const delta = parse(d);
    const shifted = shiftSamples(samples, delta);
    const { tail } = run(shifted);
    const p = pValue(tail);
    const inSet = cmp(p, a) > 0;
    if (inSet) set.push(d);
    candidates.push({
      delta: d, p: toString(p),
      countGE: tail.countGE.toString(), total: tail.total.toString(), inSet,
    });
    certificates.push(certify(shifted, tail));
  }
  return {
    alpha, rule: "delta in set iff p_delta > alpha (strict)",
    candidates, set, certificates,
  };
}
