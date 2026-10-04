import { clone, deepEqual, digest, formatPath, isPlainObject, pathKey, } from "./json.js";
import { indexResolutions, matchResolution, pickValue, } from "./resolution.js";
import { diff } from "./diff.js";
export function merge3(input) {
    const { base, ours, theirs } = input;
    const byPath = indexResolutions(input.resolutions ?? []);
    const conflicts = [];
    const applied = [];
    const walk = (b, o, t, path) => {
        if (deepEqual(o, t))
            return clone(o);
        if (deepEqual(b, o))
            return clone(t);
        if (deepEqual(b, t))
            return clone(o);
        if (isPlainObject(o) && isPlainObject(t) && (b === undefined || isPlainObject(b))) {
            const bObj = isPlainObject(b) ? b : {};
            const out = {};
            const keys = new Set([...Object.keys(bObj), ...Object.keys(o), ...Object.keys(t)]);
            for (const key of keys) {
                const child = walk(bObj[key], o[key], t[key], [...path, key]);
                if (child !== undefined)
                    out[key] = child;
            }
            return out;
        }
        // Genuine conflict: both sides changed this field differently.
        const res = byPath.get(pathKey(path));
        const info = {
            path: [...path],
            displayPath: formatPath(path),
            status: "pending",
            base: b,
            ours: o,
            theirs: t,
            baseDigest: digest(b),
            oursDigest: digest(o),
            theirsDigest: digest(t),
            origin: "both",
        };
        if (res) {
            const match = matchResolution(res, { ours, theirs });
            if (match.matches) {
                const value = pickValue(res.choice, { base, ours, theirs }, path);
                applied.push({
                    path: [...path],
                    displayPath: formatPath(path),
                    resolution: res,
                    value,
                });
                return value === undefined ? undefined : clone(value);
            }
            // Source moved on: stale resolution, conflict reopens.
            info.status = "reopened";
            info.staleResolution = res;
            info.staleReason = match.staleReason;
        }
        conflicts.push(info);
        // Unresolved conflicts keep ours by convention so the merged doc stays total.
        return o === undefined ? undefined : clone(o);
    };
    const merged = walk(base, ours, theirs, []);
    const result = {
        merged,
        conflicts,
        applied,
        diff: diff(base, merged),
        clean: conflicts.length === 0,
    };
    return result;
}
