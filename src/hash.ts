/**
 * 32-bit digests used for bucket summaries and record values.
 * The digest function is injectable so tests can force collisions.
 */
export type DigestFn = (data: Uint8Array) => number;

/** FNV-1a 32-bit — the default, well-distributed digest. */
export const fnv1a32: DigestFn = (data: Uint8Array): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

/** A digest that returns the same value for every input — injected collisions. */
export const constantDigest = (constant: number): DigestFn => {
  return () => constant >>> 0;
};

const encoder = new TextEncoder();

export const digestOfString = (digest: DigestFn, s: string): number =>
  digest(encoder.encode(s));

/** Combine two 32-bit values into one (order-sensitive). */
export const mix32 = (a: number, b: number): number => {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ (b >>> 0), 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
};
