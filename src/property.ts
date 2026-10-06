import * as fs from "node:fs";
import { Rng, hashSeed, mixSeed } from "./rng";
import { Gen } from "./gen";
import { shrink, ShrinkStep } from "./shrink";

export interface RunConfig {
  /** Master seed; combined with the property name, never with run order. */
  seed: number;
  /** Number of random cases to generate. */
  runs: number;
  /** Size hint per run index; defaults to the run index itself. */
  size?: (runIndex: number) => number;
  /** Where to persist failure records. Undefined disables persistence. */
  failureDir?: string;
}

/**
 * Everything needed to regenerate the exact failing case and re-walk
 * the exact shrink path, without any dependence on other tests.
 */
export interface FailureRecord {
  property: string;
  masterSeed: number;
  propertySeed: number;
  runIndex: number;
  runSeed: number;
  size: number;
  counterexample: unknown;
  shrinkPath: number[];
  shrinkTrace: ShrinkStep[];
}

export interface PropertyResult {
  ok: boolean;
  runs: number;
  record?: FailureRecord;
}

export type Check<T> = (value: T) => boolean;

/** Wrap a check so thrown exceptions also count as failures. */
function toFails<T>(check: Check<T>): (value: T) => boolean {
  return (value: T) => {
    try {
      return !check(value);
    } catch {
      return true;
    }
  };
}

/**
 * Run a property. The random stream for run i is derived solely from
 * hashSeed(seed, name) and i, so the outcome is identical no matter
 * which other properties run before/after or concurrently.
 */
export function runProperty<T>(
  name: string,
  gen: Gen<T>,
  check: Check<T>,
  config: RunConfig
): PropertyResult {
  const propertySeed = hashSeed(config.seed, name);
  const fails = toFails(check);

  for (let run = 0; run < config.runs; run++) {
    const runSeed = mixSeed(propertySeed, run);
    const size = config.size ? config.size(run) : run;
    const rng = new Rng(runSeed);
    const tree = gen(rng, size);

    if (!fails(tree.value)) continue;

    const result = shrink(tree, fails);
    const record: FailureRecord = {
      property: name,
      masterSeed: config.seed,
      propertySeed,
      runIndex: run,
      runSeed,
      size,
      counterexample: result.minimal,
      shrinkPath: result.acceptedPath,
      shrinkTrace: result.trace,
    };
    if (config.failureDir !== undefined) {
      saveFailureRecord(config.failureDir, record);
    }
    return { ok: false, runs: run + 1, record };
  }
  return { ok: true, runs: config.runs };
}

export function failureFilePath(dir: string, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_.-]+/g, "_");
  return `${dir}/${safe}.json`;
}

export function saveFailureRecord(dir: string, record: FailureRecord): string {
  fs.mkdirSync(dir, { recursive: true });
  const path = failureFilePath(dir, record.property);
  fs.writeFileSync(path, JSON.stringify(record, null, 2));
  return path;
}

export function loadFailureRecord(path: string): FailureRecord {
  return JSON.parse(fs.readFileSync(path, "utf8")) as FailureRecord;
}

/**
 * Test-runner friendly wrapper: returns nothing on success, throws an
 * Error with the full failure summary (and persists the record) on
 * failure.
 */
export function assertProperty<T>(
  name: string,
  gen: Gen<T>,
  check: Check<T>,
  config: RunConfig
): void {
  const result = runProperty(name, gen, check, config);
  if (!result.ok && result.record) {
    const r = result.record;
    throw new Error(
      [
        `Property "${name}" falsified after ${result.runs} run(s).`,
        `  counterexample: ${JSON.stringify(r.counterexample)}`,
        `  seed: ${r.masterSeed}, run: ${r.runIndex}, runSeed: ${r.runSeed}, size: ${r.size}`,
        `  shrink steps: ${r.shrinkTrace.length} (${r.shrinkPath.length} accepted)`,
        config.failureDir !== undefined
          ? `  record: ${failureFilePath(config.failureDir, name)}`
          : "  (persistence disabled)",
      ].join("\n")
    );
  }
}
