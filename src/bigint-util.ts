/** Exact integer utilities over BigInt. */

export function gcd(a: bigint, b: bigint): bigint {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

export function gcd3(a: bigint, b: bigint, c: bigint): bigint {
  return gcd(gcd(a, b), c);
}

export function lcm(a: bigint, b: bigint): bigint {
  if (a === 0n || b === 0n) return 0n;
  return (a / gcd(a, b)) * b;
}

export function bitLength(n: bigint): number {
  if (n < 0n) n = -n;
  return n.toString(2).length;
}

/** Floor of the integer square root of a non-negative integer. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError('isqrt: negative input');
  if (n < 2n) return n;
  // Over-estimate initial guess: 2^ceil(bits/2) >= sqrt(n).
  let x = 1n << BigInt(Math.ceil(bitLength(n) / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** Returns floor(sqrt(n)) when n is a perfect square, otherwise null. */
export function isPerfectSquare(n: bigint): bigint | null {
  if (n < 0n) return null;
  const s = isqrt(n);
  return s * s === n ? s : null;
}

/**
 * Extracts square factors: returns { root, squarefree } with
 * n = root^2 * squarefree. Square factors are divided out completely for
 * prime factors up to 100000; any remaining large square is detected via
 * a perfect-square test. The result is always exact (root^2 * squarefree = n),
 * even if `squarefree` still hides a square of a huge prime.
 */
export function squarefreePart(n: bigint): { root: bigint; squarefree: bigint } {
  if (n <= 0n) throw new RangeError('squarefreePart: input must be positive');
  let root = 1n;
  let rest = n;
  for (let p = 2n; p * p <= rest && p <= 100000n; p += p === 2n ? 1n : 2n) {
    const p2 = p * p;
    while (rest % p2 === 0n) {
      rest /= p2;
      root *= p;
    }
  }
  const s = isPerfectSquare(rest);
  if (s !== null) {
    root *= s;
    rest = 1n;
  }
  return { root, squarefree: rest };
}
