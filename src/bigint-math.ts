/**
 * Exact bigint arithmetic helpers. No floating point is ever used for
 * bound computations: all divisions are floor/ceil divisions on bigint.
 */

export function absBig(a: bigint): bigint {
  return a < 0n ? -a : a;
}

export function gcd(a: bigint, b: bigint): bigint {
  let x = absBig(a);
  let y = absBig(b);
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

export function lcm(a: bigint, b: bigint): bigint {
  if (a === 0n || b === 0n) return 0n;
  return absBig(a / gcd(a, b) * b);
}

/** Floor division: largest integer q with q * b <= a. Requires b !== 0. */
export function floorDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error("floorDiv: division by zero");
  const q = a / b;
  const r = a % b;
  return r !== 0n && (r < 0n) !== (b < 0n) ? q - 1n : q;
}

/** Ceil division: smallest integer q with q * b >= a. Requires b !== 0. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error("ceilDiv: division by zero");
  const q = a / b;
  const r = a % b;
  return r !== 0n && (r < 0n) === (b < 0n) ? q + 1n : q;
}

/** Non-negative remainder modulo m. Requires m > 0. Result in [0, m). */
export function mod(a: bigint, m: bigint): bigint {
  if (m <= 0n) throw new Error("mod: modulus must be positive");
  const r = a % m;
  return r < 0n ? r + m : r;
}

/**
 * Modular inverse of a modulo m (m > 0). Returns the unique x in [0, m)
 * with a*x === 1 (mod m), or null if gcd(a, m) !== 1.
 */
export function modInverse(a: bigint, m: bigint): bigint | null {
  if (m <= 0n) throw new Error("modInverse: modulus must be positive");
  if (m === 1n) return 0n;
  let t = 0n;
  let newT = 1n;
  let r = m;
  let newR = mod(a, m);
  while (newR !== 0n) {
    const q = r / newR;
    const tmpT = t - q * newT;
    t = newT;
    newT = tmpT;
    const tmpR = r - q * newR;
    r = newR;
    newR = tmpR;
  }
  if (r !== 1n) return null;
  return mod(t, m);
}

export interface Congruence {
  residue: bigint; // normalized to [0, modulus)
  modulus: bigint; // > 0
}

/**
 * Merge two congruences x === r1 (mod m1) and x === r2 (mod m2) via CRT.
 * Returns the combined congruence modulo lcm(m1, m2), or null (with the
 * offending gcd) when the pair is inconsistent.
 */
export function crtMerge(
  first: Congruence,
  second: Congruence
): { congruence: Congruence } | { conflict: { gcd: bigint } } {
  const g = gcd(first.modulus, second.modulus);
  const diff = second.residue - first.residue;
  if (mod(diff, g) !== 0n) {
    return { conflict: { gcd: g } };
  }
  const m1 = first.modulus / g;
  const m2 = second.modulus / g;
  let t = 0n;
  if (m2 !== 1n) {
    const inv = modInverse(m1, m2);
    if (inv === null) throw new Error("crtMerge: internal error, inverse missing");
    t = mod((diff / g) * inv, m2);
  }
  const modulus = first.modulus * m2;
  const residue = mod(first.residue + first.modulus * t, modulus);
  return { congruence: { residue, modulus } };
}
