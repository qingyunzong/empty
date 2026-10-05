import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
export function sha256(data) {
    return createHash('sha256').update(data).digest('hex');
}
/** Deterministic JSON: object keys sorted recursively. */
export function stableStringify(value) {
    return JSON.stringify(sortValue(value));
}
function sortValue(value) {
    if (Array.isArray(value))
        return value.map(sortValue);
    if (value !== null && typeof value === 'object') {
        const source = value;
        const sorted = {};
        for (const key of Object.keys(source).sort())
            sorted[key] = sortValue(source[key]);
        return sorted;
    }
    return value;
}
/** Hash the identity + content of input files (missing files are recorded). */
export function hashInputFiles(paths) {
    const hash = createHash('sha256');
    for (const path of [...paths].sort()) {
        hash.update(path);
        hash.update('\0');
        hash.update(existsSync(path) ? readFileSync(path) : Buffer.from('<missing>'));
        hash.update('\0');
    }
    return hash.digest('hex');
}
/**
 * Cache key for one stage invocation: stage identity + input-file content +
 * the outputs of all direct dependencies. Any upstream change (file edit or
 * different dependency output) yields a different digest, which is what makes
 * stale success records unreachable.
 */
export function stageDigest(stageId, fileHash, depOutputs) {
    return sha256(stableStringify({ stageId, fileHash, depOutputs }));
}
