/**
 * Kleene three-valued logic (strong logic of indeterminacy).
 *
 *   and: false dominates, then unknown, else true
 *   or:  true dominates, then unknown, else false
 *   not: true <-> false, unknown stays unknown
 *
 * "unknown" represents missing or incomparable information; it is
 * propagated, never silently coerced to true or false.
 */

export type TVL = "true" | "false" | "unknown";

export const T: TVL = "true";
export const F: TVL = "false";
export const U: TVL = "unknown";

export function tvlOfBool(b: boolean): TVL {
  return b ? T : F;
}

export function tvlNot(a: TVL): TVL {
  return a === T ? F : a === F ? T : U;
}

export function tvlAnd(...args: readonly TVL[]): TVL {
  let sawUnknown = false;
  for (const a of args) {
    if (a === F) return F;
    if (a === U) sawUnknown = true;
  }
  return sawUnknown ? U : T;
}

export function tvlOr(...args: readonly TVL[]): TVL {
  let sawUnknown = false;
  for (const a of args) {
    if (a === T) return T;
    if (a === U) sawUnknown = true;
  }
  return sawUnknown ? U : F;
}
