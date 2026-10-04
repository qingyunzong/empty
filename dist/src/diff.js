import { clone, deepEqual, formatPath, isPlainObject } from "./json.js";
/** Field-level diff from `from` to `to`; recurses into plain objects. */
export function diff(from, to) {
    const ops = [];
    const walk = (a, b, path) => {
        if (deepEqual(a, b))
            return;
        if (isPlainObject(a) && isPlainObject(b)) {
            const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
            for (const key of keys)
                walk(a[key], b[key], [...path, key]);
            return;
        }
        if (b === undefined) {
            ops.push({ op: "remove", path: [...path], displayPath: formatPath(path), from: a });
        }
        else {
            ops.push({ op: "set", path: [...path], displayPath: formatPath(path), from: a, to: clone(b) });
        }
    };
    walk(from, to, []);
    return ops;
}
/** Apply a diff to a document, returning a new document. */
export function applyDiff(doc, ops) {
    const root = isPlainObject(doc) ? { ...doc } : clone(doc);
    for (const op of ops) {
        if (op.path.length === 0) {
            if (op.op === "set")
                return clone(op.to);
            continue;
        }
        let cur = root;
        for (let i = 0; i < op.path.length - 1; i++) {
            const key = op.path[i];
            const next = cur[key];
            if (!isPlainObject(next)) {
                cur[key] = {};
            }
            else {
                // Copy-on-write so the input document is never mutated.
                cur[key] = { ...next };
            }
            cur = cur[key];
        }
        const last = op.path[op.path.length - 1];
        if (op.op === "set")
            cur[last] = clone(op.to);
        else
            delete cur[last];
    }
    return root;
}
