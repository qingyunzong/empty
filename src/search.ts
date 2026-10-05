import { isWitness } from "./evaluate.js";
import { enumeratePartial, spaceSize } from "./order.js";
import type { Assignment, Effect, Spec } from "./types.js";

export const DEFAULT_BUDGET = 1_000_000;

export type Verdict = "DIFFER" | "EQUIVALENT" | "UNDECIDED";

export interface SearchResult {
  verdict: Verdict;
  /** Number of candidate assignments evaluated. */
  checked: number;
  /** Total size of the partial-assignment space. */
  space: bigint;
  budget: number;
  /** Present iff verdict is DIFFER. */
  witness?: Assignment;
  /** Decisions of [policyA, policyB] on the witness. */
  decisions?: [Effect, Effect];
}

/**
 * Bounded search for the minimal difference witness in canonical order.
 *  - DIFFER:     a witness was found (minimal by the canonical order).
 *  - EQUIVALENT: the whole space was enumerated, no witness exists (exhaustive proof).
 *  - UNDECIDED:  the budget ran out before the space was exhausted.
 */
export function search(spec: Spec, budget: number = spec.budget ?? DEFAULT_BUDGET): SearchResult {
  const space = spaceSize(spec);
  const it = enumeratePartial(spec);
  let checked = 0;
  for (;;) {
    if (checked >= budget) {
      const peek = it.next();
      return peek.done
        ? { verdict: "EQUIVALENT", checked, space, budget }
        : { verdict: "UNDECIDED", checked, space, budget };
    }
    const next = it.next();
    if (next.done) return { verdict: "EQUIVALENT", checked, space, budget };
    checked++;
    const witness = isWitness(spec.policies, next.value);
    if (witness) {
      return { verdict: "DIFFER", checked, space, budget, witness: next.value, decisions: witness };
    }
  }
}
