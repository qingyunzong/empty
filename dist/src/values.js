/** SQL NULL three-valued logic (3VL) primitives. */
export const T = "true";
export const F = "false";
export const U = "unknown";
export function triOf(b) {
    return b ? T : F;
}
export function triNot(a) {
    return a === T ? F : a === F ? T : U;
}
export function triAnd(a, b) {
    if (a === F || b === F)
        return F;
    if (a === T && b === T)
        return T;
    return U;
}
export function triOr(a, b) {
    if (a === T || b === T)
        return T;
    if (a === F && b === F)
        return F;
    return U;
}
/** SQL equality on values: NULL compared to anything is UNKNOWN. */
export function sqlEq(a, b) {
    if (a === null || b === null)
        return U;
    return triOf(a === b);
}
/** SQL ordering comparison; NULL on either side is UNKNOWN. */
export function sqlCmp(op, a, b) {
    if (a === null || b === null)
        return U;
    if (typeof a !== typeof b)
        return U; // ill-typed comparison: UNKNOWN, never TRUE
    switch (op) {
        case "<": return triOf(a < b);
        case "<=": return triOf(a <= b);
        case ">": return triOf(a > b);
        case ">=": return triOf(a >= b);
    }
}
