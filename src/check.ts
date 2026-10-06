import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Rng, deriveSeed } from "./rng.js";
import type { Gen } from "./gen.js";

export type Property<T> = (value: T) => boolean | void;

export interface CheckOptions {
  /** Number of random iterations after the fixed small cases. Default 100. */
  runs?: number;
  /**
   * Run seed. The effective seed for a test is deriveSeed(seed, testName),
   * so every test gets its own independent integer random state and results
   * never depend on the order in which tests execute.
   */
  seed?: number | bigint;
  /** Logical name of the test; part of the seed derivation. */
  testName?: string;
  /** Directory where failure records are persisted. Default "failures". */
  failureDir?: string;
}

export interface ShrinkStep {
  candidate: unknown;
  /** true only if re-running the property on the candidate genuinely failed. */
  accepted: boolean;
}

export interface FailureRecord {
  testName: string;
  /** Run seed (decimal string), combined with testName to derive the test seed. */
  seed: string;
  /** Random iteration index, or -1 for a fixed small case. */
  iteration: number;
  /** Index into gen.smalls() when kind === "small", else -1. */
  smallIndex: number;
  kind: "small" | "random";
  /** Originally generated failing value. */
  original: unknown;
  /** Final shrunk counterexample. */
  counterexample: unknown;
  /** Every shrink candidate tried, in order, with its genuine outcome. */
  shrinkTrace: ShrinkStep[];
  /** True after the final counterexample was re-run and still failed. */
  replayConfirmed: boolean;
  /** Path of the persisted record file. */
  file: string;
}

export interface Success {
  ok: true;
  testName: string;
  /** Random iterations executed (fixed small cases not included). */
  runs: number;
  /** Fixed small cases checked before random generation. */
  smallCases: number;
}

export class PropertyFailure extends Error {
  readonly record: FailureRecord;
  constructor(record: FailureRecord, errorMessage?: string) {
    super(
      `Property "${record.testName}" falsified` +
        ` (seed=${record.seed}, iteration=${record.iteration})` +
        `\n  counterexample: ${JSON.stringify(record.counterexample)}` +
        (errorMessage ? `\n  error: ${errorMessage}` : "") +
        `\n  record saved to: ${record.file}`,
    );
    this.name = "PropertyFailure";
    this.record = record;
  }
}

const DEFAULT_SEED = 0x5eedn;

interface RunResult {
  failed: boolean;
  errorMessage?: string;
}

function runProperty<T>(property: Property<T>, value: T): RunResult {
  try {
    const out = property(value);
    return out === false ? { failed: true } : { failed: false };
  } catch (err) {
    return { failed: true, errorMessage: String(err) };
  }
}

/**
 * Greedy shrinking. A candidate is accepted ONLY if re-running the property
 * on it genuinely fails (returns false or throws). Every attempt is recorded
 * in the trace with its true outcome.
 */
function shrink<T>(
  gen: Gen<T>,
  property: Property<T>,
  value: T,
): { minimal: T; trace: ShrinkStep[]; errorMessage?: string } {
  const trace: ShrinkStep[] = [];
  let current = value;
  let errorMessage: string | undefined;
  let improved = true;
  while (improved) {
    improved = false;
    for (const candidate of gen.shrink(current)) {
      const result = runProperty(property, candidate);
      trace.push({ candidate, accepted: result.failed });
      if (result.failed) {
        current = candidate;
        errorMessage = result.errorMessage;
        improved = true;
        break; // restart from the new, smaller failing value
      }
    }
  }
  return { minimal: current, trace, errorMessage };
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 80) || "test";
}

function persist(record: Omit<FailureRecord, "file">, failureDir: string): string {
  mkdirSync(failureDir, { recursive: true });
  const hash = deriveSeed(record.testName, record.seed, record.iteration)
    .toString(16)
    .padStart(16, "0");
  const file = join(failureDir, `${sanitizeFileName(record.testName)}-${hash}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
  return file;
}

/**
 * Run a property against a generator.
 *
 * Order of checks:
 *   1. The generator's fixed small cases (deterministic baseline).
 *   2. `runs` random cases, each drawn from Rng(deriveSeed(seed, testName, i))
 *      so every iteration is reproducible on its own, independent of any
 *      other test or iteration.
 *
 * On failure the value is shrunk (accepting only genuine failures), the
 * final counterexample is re-run to confirm it still fails, and a record
 * with generation parameters and the full shrink trace is saved to disk.
 */
export function check<T>(
  property: Property<T>,
  gen: Gen<T>,
  options: CheckOptions = {},
): Success {
  const runs = options.runs ?? 100;
  const seed = BigInt(options.seed ?? DEFAULT_SEED);
  const testName = options.testName ?? (property.name || "anonymous");
  const failureDir = options.failureDir ?? "failures";
  const testSeed = deriveSeed(seed, testName);

  const fail = (
    kind: "small" | "random",
    iteration: number,
    smallIndex: number,
    original: T,
  ): never => {
    const { minimal, trace, errorMessage } = shrink(gen, property, original);
    // Replay: the final counterexample must still genuinely fail.
    const replay = runProperty(property, minimal);
    if (!replay.failed) {
      throw new Error(
        `Property "${testName}": final counterexample did not fail on replay; ` +
          "the property is non-deterministic, so shrinking/replay is unsound.",
      );
    }
    const recordWithoutFile = {
      testName,
      seed: seed.toString(10),
      iteration,
      smallIndex,
      kind,
      original,
      counterexample: minimal,
      shrinkTrace: trace,
      replayConfirmed: true,
    };
    const file = persist(recordWithoutFile, failureDir);
    throw new PropertyFailure({ ...recordWithoutFile, file }, errorMessage);
  };

  // Phase 1: fixed small cases (seed-independent baseline).
  const smalls = gen.smalls();
  for (let i = 0; i < smalls.length; i++) {
    if (runProperty(property, smalls[i]).failed) {
      fail("small", -1, i, smalls[i]);
    }
  }

  // Phase 2: random cases with per-iteration independent integer state.
  for (let i = 0; i < runs; i++) {
    const rng = new Rng(deriveSeed(testSeed, i));
    const value = gen.generate(rng);
    if (runProperty(property, value).failed) {
      fail("random", i, -1, value);
    }
  }

  return { ok: true, testName, runs, smallCases: smalls.length };
}

/**
 * Deterministically replay a persisted failure record:
 * regenerates the original value from (seed, testName, iteration),
 * verifies it matches the record, and confirms both the original value
 * and the final counterexample still fail the property.
 */
export function replay<T>(
  record: FailureRecord,
  gen: Gen<T>,
  property: Property<T>,
): { originalReproduced: boolean; originalFails: boolean; counterexampleFails: boolean } {
  let original: T;
  if (record.kind === "small") {
    original = gen.smalls()[record.smallIndex];
  } else {
    const testSeed = deriveSeed(BigInt(record.seed), record.testName);
    const rng = new Rng(deriveSeed(testSeed, record.iteration));
    original = gen.generate(rng);
  }
  const originalReproduced =
    JSON.stringify(original) === JSON.stringify(record.original);
  const originalFails = runProperty(property, original).failed;
  const counterexampleFails = runProperty(
    property,
    record.counterexample as T,
  ).failed;
  return { originalReproduced, originalFails, counterexampleFails };
}
