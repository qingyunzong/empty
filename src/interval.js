import { Rational } from './rational.js';
import { qerror } from './errors.js';

export class Interval {
  constructor(lo, hi) {
    this.lo = Rational.from(lo);
    this.hi = Rational.from(hi);
    if (this.lo.gt(this.hi)) {
      throw qerror(
        'E_INTERVAL',
        `illegal interval: lower bound ${this.lo} exceeds upper bound ${this.hi}`
      );
    }
    Object.freeze(this);
  }

  contains(t) {
    t = Rational.from(t);
    return this.lo.le(t) && t.le(this.hi);
  }

  toJSON() {
    return { lo: this.lo.toString(), hi: this.hi.toString() };
  }
}
