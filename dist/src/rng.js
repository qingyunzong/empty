/**
 * Serializable seeded PRNG (xoshiro128** over a 4x32-bit state).
 * The whole generator state is four uint32 numbers, so a seed or a
 * mid-stream snapshot round-trips through JSON losslessly.
 */
function splitmix32(state) {
    state.a = (state.a + 0x9e3779b9) >>> 0;
    let z = state.a;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    z = z ^ (z >>> 15);
    return z >>> 0;
}
export class Rng {
    state;
    constructor(seed) {
        const sm = { a: seed >>> 0 };
        this.state = [splitmix32(sm), splitmix32(sm), splitmix32(sm), splitmix32(sm)];
        if (this.state.every((w) => w === 0))
            this.state[0] = 0x9e3779b9;
    }
    static fromSnapshot(snap) {
        const rng = new Rng(0);
        rng.state = [snap.s[0] >>> 0, snap.s[1] >>> 0, snap.s[2] >>> 0, snap.s[3] >>> 0];
        return rng;
    }
    snapshot() {
        return { s: [...this.state] };
    }
    clone() {
        return Rng.fromSnapshot(this.snapshot());
    }
    nextU32() {
        const [s0, s1, s2, s3] = this.state;
        const result = (rotl((s1 * 5) >>> 0, 7) * 9) >>> 0;
        const t = (s1 << 9) >>> 0;
        this.state[2] = (s2 ^ s0) >>> 0;
        this.state[3] = (s3 ^ s1) >>> 0;
        this.state[1] = (s1 ^ this.state[2]) >>> 0;
        this.state[0] = (s0 ^ this.state[3]) >>> 0;
        this.state[2] = (this.state[2] ^ t) >>> 0;
        this.state[3] = rotl(this.state[3], 11);
        return result;
    }
    /** Uniform integer in [minInclusive, maxInclusive]. */
    nextInt(minInclusive, maxInclusive) {
        if (maxInclusive < minInclusive) {
            throw new Error(`invalid range [${minInclusive}, ${maxInclusive}]`);
        }
        const span = maxInclusive - minInclusive + 1;
        if (span >= 0x100000000)
            return minInclusive + this.nextU32();
        // rejection sampling to avoid modulo bias
        const limit = Math.floor(0x100000000 / span) * span;
        let x = this.nextU32();
        while (x >= limit)
            x = this.nextU32();
        return minInclusive + (x % span);
    }
    nextBool() {
        return (this.nextU32() & 1) === 1;
    }
    /** Derive an independent child stream (used per generated case). */
    fork() {
        return new Rng(this.nextU32());
    }
}
function rotl(x, k) {
    return ((x << k) | (x >>> (32 - k))) >>> 0;
}
/** Deterministically derive the RNG for generated case #runIndex of a check. */
export function caseRng(seed, runIndex) {
    const root = new Rng(seed);
    for (let i = 0; i <= runIndex; i++)
        root.nextU32();
    return root.fork();
}
