/**
 * Independent rational reference used to verify the library.
 * Deliberately written as a separate, naive implementation: fractions are
 * plain {n, d} pairs and time is accumulated tick by tick instead of per
 * segment, so the tests cross-check two different computation paths.
 */
export interface RefFrac {
  n: bigint;
  d: bigint; // always > 0
}

export interface RefSegment {
  tick: number;
  num: bigint;
  den: bigint;
}

function norm(f: RefFrac): RefFrac {
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

export function refAdd(a: RefFrac, b: RefFrac): RefFrac {
  return norm({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
}

export function refRoundHalfEven(f: RefFrac): bigint {
  let q = f.n / f.d;
  let r = f.n % f.d;
  if (r < 0n) {
    q -= 1n;
    r += f.d;
  }
  if (2n * r < f.d) return q;
  if (2n * r > f.d) return q + 1n;
  return q % 2n === 0n ? q : q + 1n;
}

function segmentAt(segs: readonly RefSegment[], tick: number): RefSegment {
  let current = segs[0]!;
  for (const s of segs) {
    if (s.tick > tick) break;
    current = s;
  }
  return current;
}

/** Exact time of `tick`, accumulated one tick at a time. */
export function refExactTime(segs: readonly RefSegment[], tick: number): RefFrac {
  let acc: RefFrac = { n: 0n, d: 1n };
  for (let t = 0; t < tick; t++) {
    const s = segmentAt(segs, t);
    acc = refAdd(acc, { n: s.num, d: s.den });
  }
  return acc;
}

export function refTickToUs(segs: readonly RefSegment[], tick: number): bigint {
  return refRoundHalfEven(refExactTime(segs, tick));
}

/** Deterministic PRNG (mulberry32) for reproducible property tests. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
