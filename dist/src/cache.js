import { createHash } from 'node:crypto';
import { canonicalizeUrl } from './canonicalize.js';
/**
 * Cache of canonicalization results.
 *
 * The cache key mixes the canonical form with a fingerprint of the exact
 * original URL, so two originals that canonicalize to the same bytes but
 * differ in their original duplicate parameters (e.g. `?a=1&a=2` vs
 * `?a=2&a=1`) never share an entry — each keeps its own original-interval
 * mapping.
 */
export class CanonicalizationCache {
    entries = new Map();
    keyFor(url, canonical) {
        const canonicalHash = createHash('sha256').update(canonical).digest('hex');
        const originalHash = createHash('sha256').update(url).digest('hex');
        return `${canonicalHash}:${originalHash}`;
    }
    get(url) {
        const result = canonicalizeUrl(url);
        const key = this.keyFor(url, result.canonical);
        const hit = this.entries.get(key);
        if (hit)
            return hit;
        this.entries.set(key, result);
        return result;
    }
    get size() {
        return this.entries.size;
    }
    /** Number of distinct canonical forms currently cached. */
    get distinctCanonicals() {
        return new Set([...this.entries.values()].map((e) => e.canonical)).size;
    }
}
