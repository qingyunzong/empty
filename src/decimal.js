// Exact decimal accumulator: order-independent sums, so incremental
// updates and full recompute produce bit-identical results.

function parseDecimal(n) {
  let s = n.toString();
  let exp = 0;
  const eIdx = s.indexOf('e');
  if (eIdx >= 0) {
    exp = parseInt(s.slice(eIdx + 1), 10);
    s = s.slice(0, eIdx);
  }
  let neg = false;
  if (s.startsWith('-')) {
    neg = true;
    s = s.slice(1);
  }
  const dot = s.indexOf('.');
  if (dot >= 0) {
    exp -= s.length - dot - 1;
    s = s.slice(0, dot) + s.slice(dot + 1);
  }
  let mant = BigInt(s);
  if (neg) mant = -mant;
  return { mant, exp };
}

export class DecimalAcc {
  constructor() {
    this.mant = 0n;
    this.exp = 0;
  }

  add(num, sign = 1) {
    let { mant, exp } = parseDecimal(num);
    if (sign < 0) mant = -mant;
    if (mant === 0n) return;
    if (this.mant === 0n) {
      this.mant = mant;
      this.exp = exp;
      return;
    }
    if (exp < this.exp) {
      this.mant *= 10n ** BigInt(this.exp - exp);
      this.exp = exp;
    }
    this.mant += mant * 10n ** BigInt(exp - this.exp);
    if (this.mant === 0n) this.exp = 0;
  }

  toNumber() {
    if (this.mant === 0n) return 0;
    return Number(`${this.mant}e${this.exp}`);
  }
}
