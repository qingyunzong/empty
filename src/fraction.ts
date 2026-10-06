/** 最简有理数：n/d，d > 0，gcd(|n|, d) = 1。全部用 BigInt 精确运算。 */
export interface Fraction {
  readonly n: bigint;
  readonly d: bigint;
}

export function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a === 0n ? 1n : a;
}

export function lcm(a: bigint, b: bigint): bigint {
  if (a === 0n || b === 0n) return 0n;
  return (a / gcd(a, b)) * b;
}

export function frac(n: bigint, d: bigint = 1n): Fraction {
  if (d === 0n) throw new Error("分母为 0");
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

/** 解析 "p/q"、整数 "3"、有限小数 "-0.125" 为精确有理数。 */
export function parseFraction(text: string): Fraction {
  const s = text.trim();
  const slash = s.indexOf("/");
  if (slash >= 0) {
    const n = BigInt(s.slice(0, slash).trim());
    const d = BigInt(s.slice(slash + 1).trim());
    return frac(n, d);
  }
  if (/^[+-]?\d+$/.test(s)) return frac(BigInt(s));
  const m = /^([+-]?)(\d*)\.(\d+)$/.exec(s);
  if (m) {
    const sign = m[1] === "-" ? -1n : 1n;
    const intPart = m[2] === "" ? 0n : BigInt(m[2]);
    const scale = 10n ** BigInt(m[3].length);
    return frac(sign * (intPart * scale + BigInt(m[3])), scale);
  }
  throw new Error(`无法解析有理数: ${text}`);
}

export const add = (a: Fraction, b: Fraction): Fraction =>
  frac(a.n * b.d + b.n * a.d, a.d * b.d);

export const sub = (a: Fraction, b: Fraction): Fraction =>
  frac(a.n * b.d - b.n * a.d, a.d * b.d);

export const mul = (a: Fraction, b: Fraction): Fraction =>
  frac(a.n * b.n, a.d * b.d);

export const div = (a: Fraction, b: Fraction): Fraction =>
  frac(a.n * b.d, a.d * b.n);

export function cmp(a: Fraction, b: Fraction): number {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
}

export function formatFraction(f: Fraction): string {
  return f.d === 1n ? f.n.toString() : `${f.n}/${f.d}`;
}
