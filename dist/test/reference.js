function norm(f) {
    let { n, d } = f;
    if (d < 0n) {
        n = -n;
        d = -d;
    }
    let a = n < 0n ? -n : n;
    let b = d;
    while (b !== 0n) {
        const t = a % b;
        a = b;
        b = t;
    }
    const g = a === 0n ? 1n : a;
    return { n: n / g, d: d / g };
}
export function refAdd(a, b) {
    return norm({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
}
export function refRoundHalfEven(f) {
    let q = f.n / f.d;
    let r = f.n % f.d;
    if (r < 0n) {
        q -= 1n;
        r += f.d;
    }
    if (2n * r < f.d)
        return q;
    if (2n * r > f.d)
        return q + 1n;
    return q % 2n === 0n ? q : q + 1n;
}
function segmentAt(segs, tick) {
    let current = segs[0];
    for (const s of segs) {
        if (s.tick > tick)
            break;
        current = s;
    }
    return current;
}
/** Exact time of `tick`, accumulated one tick at a time. */
export function refExactTime(segs, tick) {
    let acc = { n: 0n, d: 1n };
    for (let t = 0; t < tick; t++) {
        const s = segmentAt(segs, t);
        acc = refAdd(acc, { n: s.num, d: s.den });
    }
    return acc;
}
export function refTickToUs(segs, tick) {
    return refRoundHalfEven(refExactTime(segs, tick));
}
/** Deterministic PRNG (mulberry32) for reproducible property tests. */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
