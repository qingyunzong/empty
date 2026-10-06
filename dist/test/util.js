/** Deterministic seeded PRNG (mulberry32) so randomized checks are reproducible. */
export function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/** Fisher–Yates shuffle driven by the given PRNG. */
export function shuffled(items, rng) {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = out[i];
        out[i] = out[j];
        out[j] = tmp;
    }
    return out;
}
/** Normalize an effective() result into a comparable plain object. */
export function normalized(entries) {
    const out = {};
    for (const e of entries) {
        out[e.perm] = {
            granted: e.granted,
            sources: e.sources.map((s) => s.opId),
            revokedBy: e.revokedBy.map((s) => s.opId),
        };
    }
    return out;
}
