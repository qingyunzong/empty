import { Rng } from "./rng";
import { Gen } from "./gen";
import { walkPath } from "./shrink";
import { FailureRecord, Check } from "./property";

export interface ReplayResult {
  /** True iff the regenerated final counterexample still fails the check. */
  reproduced: boolean;
  /** The counterexample regenerated from seed + shrink path. */
  counterexample: unknown;
  /** True iff the regenerated value matches the persisted one. */
  matchesRecord: boolean;
}

/**
 * Deterministically regenerate the failing case from the persisted
 * integer state (runSeed + size), re-walk the recorded shrink path,
 * and confirm the final counterexample genuinely still fails.
 */
export function replayFailure<T>(
  record: FailureRecord,
  gen: Gen<T>,
  check: Check<T>
): ReplayResult {
  const rng = new Rng(record.runSeed);
  const tree = gen(rng, record.size);
  const finalTree = walkPath(tree, record.shrinkPath);
  const counterexample = finalTree.value;

  let stillFails: boolean;
  try {
    stillFails = !check(counterexample);
  } catch {
    stillFails = true;
  }

  return {
    reproduced: stillFails,
    counterexample,
    matchesRecord: deepEqual(counterexample, record.counterexample),
  };
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    return (
      ka.length === kb.length &&
      ka.every((k) =>
        deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
      )
    );
  }
  return false;
}
