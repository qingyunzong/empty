// Exact rational arithmetic on BigInt. All values are stored normalized:
// denominator > 0 and gcd(|num|, den) = 1, so toString() always yields the
// reduced fraction ("最简分数").

export function gcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

export function lcm(a, b) {
  if (a === 0n || b === 0n) return 0n;
  return (a / gcd(a, b)) * b;
}

function parseDecimal(text) {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) {
    throw new Error(`invalid number: ${text}`);
  }
  const sign = m[1] === '-' ? -1n : 1n;
  const intPart = m[2] || '0';
  const fracPart = m[3] || '';
  const exp = BigInt(m[4] || '0');
  let num = BigInt(intPart + fracPart) * sign;
  let den = 10n ** BigInt(fracPart.length);
  if (exp >= 0n) num *= 10n ** exp;
  else den *= 10n ** (-exp);
  return new Rat(num, den);
}

export class Rat {
  constructor(num, den = 1n) {
    num = BigInt(num);
    den = BigInt(den);
    if (den === 0n) throw new Error('rational with zero denominator');
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    const g = gcd(num, den);
    this.num = num / g;
    this.den = den / g;
  }

  static from(value) {
    if (value instanceof Rat) return value;
    if (typeof value === 'bigint') return new Rat(value);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error(`non-finite number: ${value}`);
      return parseDecimal(String(value));
    }
    if (typeof value === 'string') {
      const t = value.trim();
      const slash = t.indexOf('/');
      if (slash >= 0) {
        return new Rat(BigInt(t.slice(0, slash).trim()), BigInt(t.slice(slash + 1).trim()));
      }
      return parseDecimal(t);
    }
    if (Array.isArray(value)) {
      if (value.length < 1 || value.length > 2) {
        throw new Error('rational array must be [num] or [num, den]');
      }
      return new Rat(BigInt(value[0]), BigInt(value.length === 2 ? value[1] : 1));
    }
    if (value && typeof value === 'object' && 'num' in value) {
      return new Rat(BigInt(value.num), BigInt(value.den ?? 1));
    }
    throw new Error(`cannot parse rational from ${JSON.stringify(value)}`);
  }

  add(o) { return new Rat(this.num * o.den + o.num * this.den, this.den * o.den); }
  sub(o) { return new Rat(this.num * o.den - o.num * this.den, this.den * o.den); }
  mul(o) { return new Rat(this.num * o.num, this.den * o.den); }
  div(o) {
    if (o.num === 0n) throw new Error('division by zero');
    return new Rat(this.num * o.den, this.den * o.num);
  }
  neg() { return new Rat(-this.num, this.den); }
  cmp(o) {
    const d = this.num * o.den - o.num * this.den;
    return d < 0n ? -1 : d > 0n ? 1 : 0;
  }
  sign() { return this.num < 0n ? -1 : this.num > 0n ? 1 : 0; }
  toString() { return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`; }
  toJSON() { return this.toString(); }
}
