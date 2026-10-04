/** Exact rational arithmetic on BigInt, always kept in lowest terms with d > 0. */
export interface Rat { readonly n: bigint; readonly d: bigint; }

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) { const t = a % b; a = b; b = t; }
  return a === 0n ? 1n : a;
}

export function rat(n: bigint, d: bigint = 1n): Rat {
  if (d === 0n) throw new Error("rational with zero denominator");
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

export const ZERO: Rat = rat(0n);
export const ONE: Rat = rat(1n);

/** Parses "3/4", "-2", "1.25", "-0.5" into an exact rational. */
export function parse(s: string): Rat {
  const t = s.trim();
  const parts = t.split("/");
  if (parts.length === 1) return parseDecimalRat(parts[0]);
  if (parts.length === 2) {
    const a = parseDecimalRat(parts[0]);
    const b = parseDecimalRat(parts[1]);
    if (b.n === 0n) throw new Error(`zero denominator in ${s}`);
    return div(a, b);
  }
  throw new Error(`bad rational: ${s}`);
}

function parseDecimalRat(s: string): Rat {
  const t = s.trim();
  const m = /^([+-]?)(\d*)(?:\.(\d+))?$/.exec(t);
  if (!m || (m[2] === "" && !m[3])) throw new Error(`bad number: ${s}`);
  const sign = m[1] === "-" ? -1n : 1n;
  const intPart = m[2] === "" ? 0n : BigInt(m[2]);
  const frac = m[3] ?? "";
  const scale = 10n ** BigInt(frac.length);
  const num = sign * (intPart * scale + (frac === "" ? 0n : BigInt(frac)));
  return rat(num, scale);
}

export function add(a: Rat, b: Rat): Rat { return rat(a.n * b.d + b.n * a.d, a.d * b.d); }
export function sub(a: Rat, b: Rat): Rat { return rat(a.n * b.d - b.n * a.d, a.d * b.d); }
export function mul(a: Rat, b: Rat): Rat { return rat(a.n * b.n, a.d * b.d); }
export function div(a: Rat, b: Rat): Rat {
  if (b.n === 0n) throw new Error("division by zero");
  return rat(a.n * b.d, a.d * b.n);
}
export function neg(a: Rat): Rat { return rat(-a.n, a.d); }
export function abs(a: Rat): Rat { return a.n < 0n ? rat(-a.n, a.d) : a; }
export function cmp(a: Rat, b: Rat): number {
  const lhs = a.n * b.d, rhs = b.n * a.d;
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}
export function isZero(a: Rat): boolean { return a.n === 0n; }
export function eq(a: Rat, b: Rat): boolean { return a.n === b.n && a.d === b.d; }
export function toString(a: Rat): string {
  return a.d === 1n ? a.n.toString() : `${a.n}/${a.d}`;
}
/** Canonical key for grouping identical values. */
export function key(a: Rat): string { return `${a.n}/${a.d}`; }
