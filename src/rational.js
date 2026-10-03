export class RationalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RationalError';
    this.code = 'E_RATIONAL';
  }
}

function gcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
}

export function rat(n, d = 1n) {
  n = BigInt(n);
  d = BigInt(d);
  if (d === 0n) throw new RationalError('zero denominator');
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d) || 1n;
  return { n: n / g, d: d / g };
}

export const ZERO = rat(0n);

export function parseRational(value) {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) return rat(BigInt(value));
    throw new RationalError(`invalid rational (non-integer JSON number, use a string): ${value}`);
  }
  if (typeof value === 'string') {
    const s = value.trim();
    let m;
    if (/^[+-]?\d+$/.test(s)) return rat(BigInt(s));
    if ((m = /^([+-]?)(\d+)\.(\d+)$/.exec(s))) {
      const sign = m[1] === '-' ? -1n : 1n;
      const ip = BigInt(m[2]);
      const fp = BigInt(m[3]);
      const scale = 10n ** BigInt(m[3].length);
      return rat(sign * (ip * scale + fp), scale);
    }
    if ((m = /^([+-]?\d+)\/(\d+)$/.exec(s))) {
      const den = BigInt(m[2]);
      if (den === 0n) throw new RationalError('zero denominator');
      return rat(BigInt(m[1]), den);
    }
    throw new RationalError(`invalid rational: ${value}`);
  }
  throw new RationalError(`invalid rational: ${JSON.stringify(value)}`);
}

export const add = (a, b) => rat(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a, b) => rat(a.n * b.d - b.n * a.d, a.d * b.d);
export const cmp = (a, b) => {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
};
export const fmt = (a) => (a.d === 1n ? a.n.toString() : `${a.n}/${a.d}`);
