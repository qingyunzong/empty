export class SchedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SchedError';
    this.code = code;
  }
}

const absBig = (a) => (a < 0n ? -a : a);

export function gcd(a, b) {
  a = absBig(a);
  b = absBig(b);
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

// A rational is a frozen plain object { n: BigInt, d: BigInt } with d > 0 and gcd(|n|, d) = 1.
export function rat(n, d = 1n) {
  n = BigInt(n);
  d = BigInt(d);
  if (d === 0n) throw new SchedError('E_RATIONAL', 'denominator is 0');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  return Object.freeze({ n: n / g, d: d / g });
}

export const ZERO = rat(0n);
export const ONE = rat(1n);

const INT_RE = /^[+-]?\d+$/;
const FRAC_RE = /^([+-]?\d+)\s*\/\s*([+-]?\d+)$/;

function parseIntComponent(value, field) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new SchedError('E_RATIONAL', `${field}: non-integer numbers are forbidden, use "p/q"`);
    }
    return BigInt(value);
  }
  if (typeof value === 'string' && INT_RE.test(value.trim())) return BigInt(value.trim());
  throw new SchedError('E_RATIONAL', `${field}: expected an integer, got ${JSON.stringify(value)}`);
}

// Accepts: integer number, bigint, "p", "p/q", {p, q} / {num, den} / {n, d}.
// Anything that would require floating point is rejected with E_RATIONAL.
export function parseRat(value, field = 'value') {
  if (typeof value === 'bigint') return rat(value);
  if (typeof value === 'number') return rat(parseIntComponent(value, field));
  if (typeof value === 'string') {
    const s = value.trim();
    const m = FRAC_RE.exec(s);
    if (m) return rat(BigInt(m[1]), BigInt(m[2]));
    if (INT_RE.test(s)) return rat(BigInt(s));
    throw new SchedError('E_RATIONAL', `${field}: cannot parse rational ${JSON.stringify(value)}`);
  }
  if (value && typeof value === 'object') {
    const p = value.p ?? value.num ?? value.n;
    const q = value.q ?? value.den ?? value.d;
    if (p !== undefined && q !== undefined) {
      return rat(parseIntComponent(p, `${field}.p`), parseIntComponent(q, `${field}.q`));
    }
    if (p !== undefined) return rat(parseIntComponent(p, `${field}.p`));
  }
  throw new SchedError('E_RATIONAL', `${field}: cannot parse rational ${JSON.stringify(value)}`);
}

export function add(a, b) {
  return rat(a.n * b.d + b.n * a.d, a.d * b.d);
}

export function sub(a, b) {
  return rat(a.n * b.d - b.n * a.d, a.d * b.d);
}

export function cmp(a, b) {
  const x = a.n * b.d;
  const y = b.n * a.d;
  return x < y ? -1 : x > y ? 1 : 0;
}

export const maxRat = (a, b) => (cmp(a, b) >= 0 ? a : b);

export function ratToString(a) {
  return a.d === 1n ? a.n.toString() : `${a.n}/${a.d}`;
}
