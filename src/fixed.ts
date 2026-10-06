import { Rng } from "./rng";
import { Gen } from "./gen";

/**
 * Fixed small generators: deterministic control generators that ignore
 * the random stream and always enumerate the same small values in the
 * same order (indexed by the size/run parameter). They serve as a
 * reproducible baseline ("对照") against which random generation +
 * shrinking results can be compared. Being stateless, they are immune
 * to test execution order by construction.
 */

/** Picks `values[size % values.length]` — pure function of the run index. */
export function fixedCycle<T>(values: readonly T[]): Gen<T> {
  if (values.length === 0) throw new Error("fixedCycle needs values");
  return (_rng, size) => {
    const index = Math.abs(Math.trunc(size)) % values.length;
    return { value: values[index]!, *shrinks() {} };
  };
}

/** Small integers 0..10 in fixed order — the canonical control generator. */
export function smallInts(): Gen<number> {
  return fixedCycle([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
}

/** Fixed small integer lists: [] then growing prefixes of [0,1,2,...]. */
export function smallIntLists(maxLength = 4): Gen<number[]> {
  const lists: number[][] = [];
  for (let len = 0; len <= maxLength; len++) {
    lists.push(Array.from({ length: len }, (_, i) => i));
  }
  return fixedCycle(lists);
}

/**
 * Deterministically enumerate the values a fixed generator produces
 * for `count` runs and return the first one failing `check`
 * (i.e. the minimal counterexample under the enumeration order),
 * or undefined if none fails.
 */
export function firstCounterexample<T>(
  gen: Gen<T>,
  check: (value: T) => boolean,
  count: number
): T | undefined {
  const rng = new Rng(0);
  for (let i = 0; i < count; i++) {
    const tree = gen(rng, i);
    if (!check(tree.value)) return tree.value;
  }
  return undefined;
}
