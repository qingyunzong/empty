import { ok } from "node:assert/strict";
import { Arbitrary } from "../src/arbitrary";

// Asserts the defining guarantee of the shrinker: no single-step shrink
// candidate of `minimal` (that satisfies the input contract) is interesting.
export function assertSingleStepIrreducible<T>(
  arb: Arbitrary<T>,
  minimal: T,
  isInteresting: (v: T) => boolean,
): void {
  ok(arb.contract(minimal), "minimal value must satisfy the input contract");
  const candidates = arb.shrink(minimal).filter((c) => arb.contract(c));
  for (const c of candidates) {
    ok(
      !isInteresting(c),
      `expected no interesting one-step shrink of ${JSON.stringify(minimal)}, ` +
        `but ${JSON.stringify(c)} is still interesting`,
    );
  }
}
