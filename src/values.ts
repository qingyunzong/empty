/** SQL NULL three-valued logic (3VL) primitives. */

export type Value = number | string | boolean | null;

/** Three-valued truth: SQL TRUE / FALSE / UNKNOWN. */
export type Tri = "true" | "false" | "unknown";

export const T: Tri = "true";
export const F: Tri = "false";
export const U: Tri = "unknown";

export function triOf(b: boolean): Tri {
  return b ? T : F;
}

export function triNot(a: Tri): Tri {
  return a === T ? F : a === F ? T : U;
}

export function triAnd(a: Tri, b: Tri): Tri {
  if (a === F || b === F) return F;
  if (a === T && b === T) return T;
  return U;
}

export function triOr(a: Tri, b: Tri): Tri {
  if (a === T || b === T) return T;
  if (a === F && b === F) return F;
  return U;
}

/** SQL equality on values: NULL compared to anything is UNKNOWN. */
export function sqlEq(a: Value, b: Value): Tri {
  if (a === null || b === null) return U;
  return triOf(a === b);
}

/** SQL ordering comparison; NULL on either side is UNKNOWN. */
export function sqlCmp(op: "<" | "<=" | ">" | ">=", a: Value, b: Value): Tri {
  if (a === null || b === null) return U;
  if (typeof a !== typeof b) return U; // ill-typed comparison: UNKNOWN, never TRUE
  switch (op) {
    case "<": return triOf(a < b);
    case "<=": return triOf(a <= b);
    case ">": return triOf(a > b);
    case ">=": return triOf(a >= b);
  }
}
