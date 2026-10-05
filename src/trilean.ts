/**
 * Kleene three-valued logic.
 * T = true, F = false, U = unknown (e.g. a referenced attribute is missing).
 */
export type Tri = 'T' | 'F' | 'U';

export const T: Tri = 'T';
export const F: Tri = 'F';
export const U: Tri = 'U';

export function triFromBoolean(value: boolean): Tri {
  return value ? T : F;
}

export function triNot(a: Tri): Tri {
  if (a === T) return F;
  if (a === F) return T;
  return U;
}

/** Kleene AND: F dominates, then U. */
export function triAnd(...args: readonly Tri[]): Tri {
  let seenUnknown = false;
  for (const a of args) {
    if (a === F) return F;
    if (a === U) seenUnknown = true;
  }
  return seenUnknown ? U : T;
}

/** Kleene OR: T dominates, then U. */
export function triOr(...args: readonly Tri[]): Tri {
  let seenUnknown = false;
  for (const a of args) {
    if (a === T) return T;
    if (a === U) seenUnknown = true;
  }
  return seenUnknown ? U : F;
}
