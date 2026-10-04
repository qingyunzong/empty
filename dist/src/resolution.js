import { digest, getAtPath, pathKey } from "./json.js";
/**
 * Bind a choice for `path` to the current sources. Digests are taken from
 * the values at `path` in base/ours/theirs right now.
 */
export function makeResolution(path, choice, sources) {
    return {
        path: [...path],
        choice,
        baseDigest: digest(getAtPath(sources.base, path)),
        oursDigest: digest(getAtPath(sources.ours, path)),
        theirsDigest: digest(getAtPath(sources.theirs, path)),
    };
}
/**
 * Check a stored resolution against the current sources. It matches only if
 * BOTH sides' values at the path still hash to the bound digests.
 */
export function matchResolution(res, sources) {
    const oursNow = digest(getAtPath(sources.ours, res.path));
    const theirsNow = digest(getAtPath(sources.theirs, res.path));
    const oursStale = oursNow !== res.oursDigest;
    const theirsStale = theirsNow !== res.theirsDigest;
    if (!oursStale && !theirsStale)
        return { matches: true };
    const staleReason = oursStale && theirsStale ? "both-changed" : oursStale ? "ours-changed" : "theirs-changed";
    return { matches: false, staleReason };
}
/** Resolve the choice to a concrete value given the current sources. */
export function pickValue(choice, sources, path) {
    switch (choice.kind) {
        case "ours":
            return getAtPath(sources.ours, path);
        case "theirs":
            return getAtPath(sources.theirs, path);
        case "base":
            return getAtPath(sources.base, path);
        case "custom":
            return choice.value;
    }
}
/** Index resolutions by field path; later entries win on duplicates. */
export function indexResolutions(resolutions) {
    const map = new Map();
    for (const res of resolutions)
        map.set(pathKey(res.path), res);
    return map;
}
