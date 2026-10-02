// Exact rational arithmetic on BigInt. All values are normalized:
// denominator > 0 and gcd(|num|, den) == 1.

export class RationalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RationalError';
    this.code = 'E_RATIONAL';
  }
}

const abs = (x) => (x < 0n ? -x : x);

function gcd(a, b) {
  a = abs(a);
  b = abs(b);
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a === 0n ? 1n : a;
}

function parseDecimal(text) {
  const m = /^([+-]?)(\d*)\.(\d+)$/.exec(text);
  if (!m) return null;
  const [, sign, intPart, fracPart] = m;
  const digits = (intPart === '' ? '0' : intPart) + fracPart;
  const num = BigInt((sign === '-' ? '-' : '') + digits);
  const den = 10n ** BigInt(fracPart.length);
  return new Frac(num, den);
}

function parseString(text) {
  const s = text.trim();
  const frac = /^([+-]?\d+)\s*\/\s*([+-]?\d+)$/.exec(s);
  if (frac) return new Frac(BigInt(frac[1]), BigInt(frac[2]));
  if (/^[+-]?\d+$/.test(s)) return new Frac(BigInt(s));
  const dec = parseDecimal(s);
  if (dec) return dec;
  throw new RationalError(`cannot parse rational: ${JSON.stringify(text)}`);
}

export class Frac {
  constructor(num, den = 1n) {
    num = BigInt(num);
    den = BigInt(den);
    if (den === 0n) throw new RationalError('denominator is zero');
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    const g = gcd(num, den);
    this.n = num / g;
    this.d = den / g;
    Object.freeze(this);
  }

  static parse(value) {
    if (value instanceof Frac) return value;
    if (typeof value === 'bigint') return new Frac(value);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new RationalError(`not a finite number: ${value}`);
      }
      return parseString(String(value));
    }
    if (typeof value === 'string') return parseString(value);
    if (value !== null && typeof value === 'object') {
      if ('num' in value || 'den' in value) {
        const num = value.num ?? 0;
        const den = value.den ?? 1;
        if (
          !['number', 'string', 'bigint'].includes(typeof num) ||
          !['number', 'string', 'bigint'].includes(typeof den)
        ) {
          throw new RationalError('invalid {num, den} rational');
        }
        return new Frac(BigInt(num), BigInt(den));
      }
    }
    throw new RationalError(`cannot parse rational: ${JSON.stringify(value)}`);
  }

  add(o) {
    o = Frac.parse(o);
    return new Frac(this.n * o.d + o.n * this.d, this.d * o.d);
  }

  sub(o) {
    o = Frac.parse(o);
    return new Frac(this.n * o.d - o.n * this.d, this.d * o.d);
  }

  mul(o) {
    o = Frac.parse(o);
    return new Frac(this.n * o.n, this.d * o.d);
  }

  div(o) {
    o = Frac.parse(o);
    if (o.n === 0n) throw new RationalError('division by zero');
    return new Frac(this.n * o.d, this.d * o.n);
  }

  neg() {
    return new Frac(-this.n, this.d);
  }

  cmp(o) {
    o = Frac.parse(o);
    const lhs = this.n * o.d;
    const rhs = o.n * this.d;
    return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
  }

  lt(o) { return this.cmp(o) < 0; }
  le(o) { return this.cmp(o) <= 0; }
  gt(o) { return this.cmp(o) > 0; }
  ge(o) { return this.cmp(o) >= 0; }
  eq(o) { return this.cmp(o) === 0; }

  isZero() {
    return this.n === 0n;
  }

  toString() {
    return this.d === 1n ? this.n.toString() : `${this.n}/${this.d}`;
  }

  toJSON() {
    return this.toString();
  }
}
