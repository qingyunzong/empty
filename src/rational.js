// Exact rational arithmetic on BigInt. No floating point anywhere.
export class RationalError extends Error {
  constructor(message = 'invalid rational') {
    super(message);
    this.code = 'E_RATIONAL';
  }
}

function gcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a === 0n ? 1n : a;
}

// Canonical form: den > 0, gcd(|num|, den) == 1.
export function rat(num, den = 1n) {
  if (typeof num !== 'bigint' || typeof den !== 'bigint') {
    throw new RationalError('rational parts must be integers');
  }
  if (den === 0n) throw new RationalError('zero denominator');
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = gcd(num, den);
  return { n: num / g, d: den / g };
}

export const zero = () => rat(0n);

export function add(a, b) {
  return rat(a.n * b.d + b.n * a.d, a.d * b.d);
}

export function neg(a) {
  return rat(-a.n, a.d);
}

export function sub(a, b) {
  return add(a, neg(b));
}

export function cmp(a, b) {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
}

export const lt = (a, b) => cmp(a, b) < 0;
export const le = (a, b) => cmp(a, b) <= 0;
export const gt = (a, b) => cmp(a, b) > 0;
export const ge = (a, b) => cmp(a, b) >= 0;
export const eq = (a, b) => cmp(a, b) === 0;
export const max = (a, b) => (cmp(a, b) >= 0 ? a : b);
export const min = (a, b) => (cmp(a, b) <= 0 ? a : b);

export function format(r) {
  return r.d === 1n ? r.n.toString() : `${r.n}/${r.d}`;
}

const INT_RE = /^[+-]?\d+$/;
const FRAC_RE = /^([+-]?\d+)\/([+-]?\d+)$/;

function toBigInt(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && INT_RE.test(v.trim())) return BigInt(v.trim());
  throw new RationalError('expected integer');
}

// Accepts: integer number, "p", "p/q", {p, q}, or an internal rational {n, d}.
// Rejects non-integer numbers (floats are forbidden) with E_RATIONAL.
export function parse(value) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new RationalError('floats are forbidden');
    return rat(BigInt(value));
  }
  if (typeof value === 'bigint') return rat(value);
  if (typeof value === 'string') {
    const s = value.trim();
    if (INT_RE.test(s)) return rat(BigInt(s));
    const m = FRAC_RE.exec(s);
    if (m) return rat(BigInt(m[1]), BigInt(m[2]));
    throw new RationalError(`bad rational string: ${s}`);
  }
  if (value && typeof value === 'object') {
    if (typeof value.n === 'bigint' && typeof value.d === 'bigint') {
      return rat(value.n, value.d);
    }
    if ('p' in value && 'q' in value) {
      return rat(toBigInt(value.p), toBigInt(value.q));
    }
  }
  throw new RationalError('unsupported rational value');
}
