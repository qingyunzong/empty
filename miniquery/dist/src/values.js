/** Value semantics: exact integers, three-valued logic, deterministic ordering. */
import { QueryError } from "./types.js";
export const UNKNOWN = null;
export function triNot(a) {
    return a === null ? null : !a;
}
export function triAnd(a, b) {
    if (a === false || b === false)
        return false;
    if (a === null || b === null)
        return null;
    return true;
}
export function triOr(a, b) {
    if (a === true || b === true)
        return true;
    if (a === null || b === null)
        return null;
    return false;
}
export function isNumeric(v) {
    return typeof v === "number" || typeof v === "bigint";
}
/** SQL-style equality. NULL on either side yields UNKNOWN. */
export function valuesEqual(a, b) {
    if (a === null || b === null)
        return UNKNOWN;
    if (isNumeric(a) && isNumeric(b))
        return numericCompare(a, b) === 0;
    if (typeof a !== typeof b)
        return false;
    return a === b;
}
/** -1 / 0 / 1 numeric comparison, exact for bigints. */
export function numericCompare(a, b) {
    if (typeof a === "bigint" && typeof b === "bigint")
        return a < b ? -1 : a > b ? 1 : 0;
    const x = Number(a);
    const y = Number(b);
    return x < y ? -1 : x > y ? 1 : 0;
}
/** Ordering comparison returning -1/0/1, or null for UNKNOWN. */
export function compare3(a, b) {
    if (a === null || b === null)
        return null;
    if (isNumeric(a) && isNumeric(b))
        return numericCompare(a, b);
    if (typeof a !== typeof b) {
        throw new QueryError(`cannot compare values of different types: ${typeof a} vs ${typeof b}`);
    }
    if (typeof a === "string")
        return a < b ? -1 : a > b ? 1 : 0;
    // booleans: false < true
    const x = a;
    const y = b;
    return x === y ? 0 : x ? 1 : -1;
}
/** Deterministic total order across all value types (used for output sorting). */
export function totalCompare(a, b) {
    const rank = (v) => v === null ? 0 : isNumeric(v) ? 1 : typeof v === "string" ? 2 : 3;
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb)
        return ra - rb;
    if (a === null || b === null)
        return 0;
    if (isNumeric(a) && isNumeric(b))
        return numericCompare(a, b);
    if (typeof a === "string")
        return a < b ? -1 : a > b ? 1 : 0;
    const x = a;
    const y = b;
    return x === y ? 0 : x ? 1 : -1;
}
/** Canonical group key: NULLs group together; 1 (int) and 1.0 (float) group together. */
export function groupKey(v) {
    if (v === null)
        return "z";
    if (typeof v === "bigint")
        return `n:${v.toString()}`;
    if (typeof v === "number")
        return `n:${Number.isInteger(v) ? v.toFixed(0) : String(v)}`;
    if (typeof v === "string")
        return `s:${JSON.stringify(v)}`;
    return `b:${v ? 1 : 0}`;
}
/** Convert a runtime value to a JSON-safe value; bigints beyond 2^53 become strings. */
export function toJsonValue(v) {
    if (typeof v === "bigint") {
        const n = Number(v);
        return Number.isSafeInteger(n) ? n : v.toString();
    }
    return v;
}
/** Parse JSON text, keeping integer literals exact as bigint. */
export function parseJsonExact(text) {
    const parse = JSON.parse;
    return parse(text, (_key, value, context) => {
        if (typeof value === "number" && typeof context?.source === "string") {
            const src = context.source;
            if (/^-?\d+$/.test(src))
                return BigInt(src);
        }
        return value;
    });
}
/** Normalize a JSON-decoded value into a runtime Value. */
export function toValue(v) {
    if (v === null || v === undefined)
        return null;
    if (typeof v === "boolean" || typeof v === "string")
        return v;
    if (typeof v === "bigint")
        return v;
    if (typeof v === "number") {
        if (!Number.isFinite(v))
            throw new QueryError(`non-finite number: ${v}`);
        return v;
    }
    throw new QueryError(`unsupported cell value: ${JSON.stringify(v)}`);
}
