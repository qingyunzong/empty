/** Exact integer arithmetic helpers. Everything operates on bigint; no floats. */

export function abs(a: bigint): bigint {
  return a < 0n ? -a : a;
}

export function gcd(a: bigint, b: bigint): bigint {
  a = abs(a);
  b = abs(b);
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

/** Mathematical floor division (rounds toward -infinity), b !== 0. */
export function floorDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error("floorDiv: division by zero");
  const q = a / b;
  const r = a % b;
  return r !== 0n && (r < 0n) !== (b < 0n) ? q - 1n : q;
}

/** Mathematical ceil division (rounds toward +infinity), b !== 0. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  return -floorDiv(-a, b);
}

/** Floor modulo; requires m > 0, result always in [0, m). */
export function floorMod(a: bigint, m: bigint): bigint {
  if (m <= 0n) throw new Error("floorMod: modulus must be positive");
  const r = a % m;
  return r < 0n ? r + m : r;
}

/** Extended gcd: returns { g, x, y } with a*x + b*y = g = gcd(a, b), g >= 0. */
export function egcd(a: bigint, b: bigint): { g: bigint; x: bigint; y: bigint } {
  let oldR = a;
  let r = b;
  let oldS = 1n;
  let s = 0n;
  let oldT = 0n;
  let t = 1n;
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
    [oldT, t] = [t, oldT - q * t];
  }
  if (oldR < 0n) {
    oldR = -oldR;
    oldS = -oldS;
    oldT = -oldT;
  }
  return { g: oldR, x: oldS, y: oldT };
}

/** Modular inverse of a modulo m (m > 0), or null when it does not exist. */
export function modInverse(a: bigint, m: bigint): bigint | null {
  const { g, x } = egcd(floorMod(a, m), m);
  return g === 1n ? floorMod(x, m) : null;
}
