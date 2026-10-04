import { createHash } from "node:crypto";
export function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function deepEqual(a, b) {
    if (a === b)
        return true;
    if (typeof a !== typeof b || a === null || b === null)
        return false;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
            return false;
        return a.every((item, i) => deepEqual(item, b[i]));
    }
    if (typeof a === "object") {
        const aObj = a;
        const bObj = b;
        const aKeys = Object.keys(aObj);
        const bKeys = Object.keys(bObj);
        if (aKeys.length !== bKeys.length)
            return false;
        return aKeys.every((k) => k in bObj && deepEqual(aObj[k], bObj[k]));
    }
    return false;
}
export function clone(value) {
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
}
/** Canonical JSON: object keys sorted recursively, so digest is structure-stable. */
export function canonicalize(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value) ?? "undefined";
    if (Array.isArray(value))
        return "[" + value.map(canonicalize).join(",") + "]";
    const obj = value;
    const body = Object.keys(obj)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k]))
        .join(",");
    return "{" + body + "}";
}
/** sha256 hex digest of the canonical form of a JSON value. */
export function digest(value) {
    return createHash("sha256").update(canonicalize(value)).digest("hex");
}
export function getAtPath(doc, path) {
    let cur = doc;
    for (const key of path) {
        if (!isPlainObject(cur))
            return undefined;
        cur = cur[key];
    }
    return cur;
}
export function pathKey(path) {
    return JSON.stringify(path);
}
export function formatPath(path) {
    return path.length === 0 ? "<root>" : path.map((p) => JSON.stringify(p)).join(".");
}
