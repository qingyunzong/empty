import { Tree } from "./tree";

export interface ShrinkStep {
  /** The candidate value that was tried. */
  candidate: unknown;
  /** True only if re-running the property on the candidate genuinely failed. */
  accepted: boolean;
}

export interface ShrinkResult<T> {
  /** Smallest value found that still genuinely fails the property. */
  minimal: T;
  /** Full trace of every candidate tried, in order. */
  trace: ShrinkStep[];
  /** Child indices of accepted steps, so the shrink path can be replayed. */
  acceptedPath: number[];
  /** How many times the property was executed while shrinking. */
  attempts: number;
}

/**
 * Greedy shrinker. A candidate is accepted ONLY if `fails` returns true
 * for it, i.e. the property is re-executed and genuinely still fails.
 * Candidates that pass (or throw differently, etc.) are rejected and
 * recorded in the trace as rejected.
 */
export function shrink<T>(tree: Tree<T>, fails: (value: T) => boolean): ShrinkResult<T> {
  const trace: ShrinkStep[] = [];
  const acceptedPath: number[] = [];
  let attempts = 0;
  let current = tree;

  outer: while (true) {
    let index = 0;
    for (const child of current.shrinks()) {
      attempts++;
      const stillFails = fails(child.value);
      trace.push({ candidate: child.value, accepted: stillFails });
      if (stillFails) {
        acceptedPath.push(index);
        current = child;
        continue outer;
      }
      index++;
    }
    return { minimal: current.value, trace, acceptedPath, attempts };
  }
}

/** Walk a shrink path (child indices) from a root tree. */
export function walkPath<T>(tree: Tree<T>, path: readonly number[]): Tree<T> {
  let current = tree;
  for (const index of path) {
    let i = 0;
    let next: Tree<T> | undefined;
    for (const child of current.shrinks()) {
      if (i === index) {
        next = child;
        break;
      }
      i++;
    }
    if (next === undefined) {
      throw new Error(`shrink path exhausted at index ${index}`);
    }
    current = next;
  }
  return current;
}
