/** Aggregate accumulators. NULL inputs are ignored (except count(*)). */

import { QueryError, type AggSpec, type Value } from "./types.js";
import { isNumeric, totalCompare } from "./values.js";

export interface Accumulator {
  add(v: Value): void;
  result(): Value;
}

export function makeAccumulator(spec: AggSpec): Accumulator {
  switch (spec.fn) {
    case "count":
      return new CountAcc(spec.arg === "*");
    case "sum":
      return new SumAcc();
    case "min":
      return new MinMaxAcc(1);
    case "max":
      return new MinMaxAcc(-1);
    case "avg":
      return new AvgAcc();
  }
}

class CountAcc implements Accumulator {
  private n = 0n;
  constructor(private readonly star: boolean) {}
  add(v: Value): void {
    if (this.star || v !== null) this.n += 1n;
  }
  result(): Value {
    return this.n;
  }
}

class SumAcc implements Accumulator {
  private intSum = 0n;
  private floatSum = 0;
  private seenInt = false;
  private seenFloat = false;
  add(v: Value): void {
    if (v === null) return;
    if (typeof v === "bigint") {
      this.intSum += v;
      this.seenInt = true;
    } else if (typeof v === "number") {
      this.floatSum += v;
      this.seenFloat = true;
    } else {
      throw new QueryError(`sum() requires numeric input, got ${typeof v}`);
    }
  }
  result(): Value {
    if (!this.seenInt && !this.seenFloat) return null;
    if (this.seenFloat) return this.floatSum + Number(this.intSum);
    return this.intSum;
  }
}

class MinMaxAcc implements Accumulator {
  private best: Value = null;
  constructor(private readonly sign: 1 | -1) {}
  add(v: Value): void {
    if (v === null) return;
    if (this.best === null) {
      this.best = v;
      return;
    }
    if (isNumeric(v) !== isNumeric(this.best)) {
      throw new QueryError("min/max over mixed types");
    }
    if (this.sign * totalCompare(v, this.best) < 0) this.best = v;
  }
  result(): Value {
    return this.best;
  }
}

class AvgAcc implements Accumulator {
  private intSum = 0n;
  private floatSum = 0;
  private n = 0n;
  private seenFloat = false;
  add(v: Value): void {
    if (v === null) return;
    if (typeof v === "bigint") {
      this.intSum += v;
    } else if (typeof v === "number") {
      this.floatSum += v;
      this.seenFloat = true;
    } else {
      throw new QueryError(`avg() requires numeric input, got ${typeof v}`);
    }
    this.n += 1n;
  }
  result(): Value {
    if (this.n === 0n) return null;
    const total = this.floatSum + Number(this.intSum);
    return total / Number(this.n);
  }
}
