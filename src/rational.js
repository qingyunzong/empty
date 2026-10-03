// Exact rational arithmetic on BigInt pairs. Every value the VM, solver and
// certificate handle is a rational { n, d } with d > 0 and gcd(|n|, d) = 1.

export function gcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a === 0n ? 1n : a;
}

export function rat(n, d = 1n) {
  n = BigInt(n);
  d = BigInt(d);
  if (d === 0n) throw new Error('rational with zero denominator');
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

export const RZERO = rat(0n);
export const RONE = rat(1n);

export function radd(a, b) { return rat(a.n * b.d + b.n * a.d, a.d * b.d); }
export function rsub(a, b) { return rat(a.n * b.d - b.n * a.d, a.d * b.d); }
export function rmul(a, b) { return rat(a.n * b.n, a.d * b.d); }
export function rdiv(a, b) {
  if (b.n === 0n) throw new Error('division by zero');
  return rat(a.n * b.d, a.d * b.n);
}
export function rneg(a) { return rat(-a.n, a.d); }
export function rcmp(a, b) {
  const lhs = a.n * b.d;
  const rhs = b.n * a.d;
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}
export function rabs(a) { return a.n < 0n ? rat(-a.n, a.d) : a; }
export function rfloor(a) {
  let q = a.n / a.d;
  if (a.n % a.d !== 0n && a.n < 0n) q -= 1n;
  return q;
}

// Decimal literal ("3", "3.5", "0.001") -> exact rational.
export function parseDecimal(text) {
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`bad number literal: ${text}`);
  const [intPart, fracPart = ''] = text.split('.');
  const den = 10n ** BigInt(fracPart.length);
  const num = BigInt(intPart + fracPart);
  return rat(num, den);
}

// Exact decimal rendering when the denominator only has factors 2 and 5,
// otherwise the exact "num/den" form. Used for plan output and certificates.
export function formatRational(r) {
  let d = r.d;
  let twos = 0n;
  let fives = 0n;
  while (d % 2n === 0n) { d /= 2n; twos++; }
  while (d % 5n === 0n) { d /= 5n; fives++; }
  if (d !== 1n) return `${r.n}/${r.d}`;
  let digits = r.n;
  let scale = twos > fives ? twos : fives;
  for (let i = fives; i < scale; i++) digits *= 5n;
  for (let i = twos; i < scale; i++) digits *= 2n;
  const neg = digits < 0n;
  let s = (neg ? -digits : digits).toString();
  const sc = Number(scale);
  if (sc === 0) return (neg ? '-' : '') + s;
  while (s.length <= sc) s = '0' + s;
  const intPart = s.slice(0, s.length - sc);
  let fracPart = s.slice(s.length - sc).replace(/0+$/, '');
  return (neg ? '-' : '') + intPart + (fracPart ? '.' + fracPart : '');
}
