import { createHash } from "node:crypto";
/** Sentinel meaning "field is absent" (deleted or never present). */
export const ABSENT = Symbol("ABSENT");
function canonical(slot) {
    if (slot === ABSENT)
        return " absent";
    const v = slot;
    if (v === null || typeof v !== "object")
        return JSON.stringify(v);
    if (Array.isArray(v))
        return "[" + v.map((x) => canonical(x)).join(",") + "]";
    const keys = Object.keys(v).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
}
/** SHA-256 summary of one side's value for a field. */
export function digest(slot) {
    return createHash("sha256").update(canonical(slot)).digest("hex");
}
export function slotEqual(a, b) {
    return canonical(a) === canonical(b);
}
function get(doc, field) {
    return Object.prototype.hasOwnProperty.call(doc, field) ? doc[field] : ABSENT;
}
/** Bind a choice for a conflict to the digests of its current sources. */
export function resolve(conflict, value) {
    return { value, leftDigest: conflict.leftDigest, rightDigest: conflict.rightDigest };
}
export function merge(base, left, right, store = {}) {
    const fields = new Set([...Object.keys(base), ...Object.keys(left), ...Object.keys(right)]);
    const merged = {};
    const conflicts = [];
    const applied = [];
    const carriedStore = {};
    for (const field of [...fields].sort()) {
        const b = get(base, field);
        const l = get(left, field);
        const r = get(right, field);
        const leftChanged = !slotEqual(b, l);
        const rightChanged = !slotEqual(b, r);
        let outcome;
        if (!leftChanged && !rightChanged) {
            outcome = b;
        }
        else if (leftChanged && !rightChanged) {
            outcome = l;
        }
        else if (rightChanged && !leftChanged) {
            outcome = r;
        }
        else if (slotEqual(l, r)) {
            outcome = l;
        }
        else {
            const ld = digest(l);
            const rd = digest(r);
            const entry = store[field];
            if (entry && entry.leftDigest === ld && entry.rightDigest === rd) {
                outcome = entry.value;
                applied.push(field);
                carriedStore[field] = entry;
            }
            else {
                const conflict = {
                    field, base: b, left: l, right: r,
                    leftDigest: ld, rightDigest: rd,
                    cause: entry ? "stale-resolution" : "both-modified",
                };
                if (entry)
                    conflict.stale = entry;
                conflicts.push(conflict);
                continue; // unresolved: field omitted from merged output
            }
        }
        if (outcome !== ABSENT)
            merged[field] = outcome;
    }
    const diff = [];
    for (const field of [...fields].sort()) {
        const from = get(base, field);
        const to = get(merged, field);
        if (slotEqual(from, to))
            continue;
        const op = from === ABSENT ? "added" : to === ABSENT ? "removed" : "changed";
        diff.push({ field, op, from, to });
    }
    return { merged, conflicts, applied, carriedStore, diff };
}
